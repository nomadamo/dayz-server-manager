import { Manager } from '../control/manager';
import { Processes } from '../services/processes';
import { LogLevel } from '../util/logger';
import { ServerState } from '../types/monitor';
import { IStatefulService } from '../types/service';
import { inject, injectable, singleton } from 'tsyringe';
import { LoggerFactory } from './loggerfactory';
import { FSAPI, InjectionTokens } from '../util/apis';
import { EventBus } from '../control/event-bus';
import { InternalEventTypes } from '../types/events';
import { ServerDetector } from './server-detector';
import { Paths } from './paths';
import * as path from 'path';

export type ServerStateListener = (state: ServerState) => any;

@singleton()
@injectable()
export class Monitor extends IStatefulService {

    public loopInterval = 500;
    private tickRunning = false;
    private lastTick = 0;

    public restartLock: boolean = false;
    private initialStart: boolean = true;

    // cached path to server lock file
    private lockPath: string;

    // saved for determining server stuck state
    private lastServerUsages: number[] = [];

    private $internalServerState: ServerState = ServerState.STOPPED;

    public constructor(
        loggerFactory: LoggerFactory,
        private manager: Manager,
        private eventBus: EventBus,
        private processes: Processes,
        private serverDetector: ServerDetector,
        private paths: Paths,
        @inject(InjectionTokens.fs) private fs: FSAPI,
    ) {
        super(loggerFactory.createLogger('Monitor'));

        if (process.argv.includes('--start-locked')) {
            this.restartLock = true;
        }
    }

    private get internalServerState(): ServerState {
        return this.$internalServerState;
    }

    private set internalServerState(state: ServerState) {
        if (this.$internalServerState === state) return;

        // prevent intermediate state change
        if (
            state === ServerState.STARTED
            && (
                this.$internalServerState === ServerState.STOPPING
            )
        ) {
            // TODO force resume after this occurs multiple times?
            return;
        }

        const previousState = this.$internalServerState;
        this.$internalServerState = state;
        this.eventBus.emit(
            InternalEventTypes.MONITOR_STATE_CHANGE,
            this.$internalServerState,
            previousState,
        );
    }

    public get serverState(): ServerState {
        return this.internalServerState;
    }

    /**
     * ServerZ (not this process) owns starting/stopping the actual DayZ server, so
     * "restart" here means signalling ServerZ's own process to shut down gracefully -
     * that already cascades through its existing SIGTERM handling into a full restart
     * via the container's restart policy. `force` is unused: there's no softer/harder
     * distinction to make here anymore, ServerZ's own shutdown handling is what decides.
     */
    public async killServer(_force?: boolean): Promise<boolean> {
        if (this.internalServerState === ServerState.STARTING || this.serverState === ServerState.STARTED) {
            this.internalServerState = ServerState.STOPPING;
        }

        if (!process.ppid) {
            this.log.log(LogLevel.ERROR, 'No parent process found - not running as a ServerZ child? Cannot restart.');
            return false;
        }

        try {
            process.kill(process.ppid, 'SIGTERM');
            return true;
        } catch (e) {
            this.log.log(LogLevel.ERROR, `Failed to signal parent process ${process.ppid}`, e);
            return false;
        }
    }

    public async start(): Promise<void> {
        if (this.timers.getTimer('tick')) return; // already started

        this.lockPath = path.join(this.paths.cwd(), 'SERVER_LOCK');

        this.lastTick = 0;
        this.tickRunning = false;
        this.timers.addInterval(
            'tick',
            () => {
                if (this.tickRunning) {
                    return;
                }
                if (
                    (new Date().valueOf() - this.lastTick)
                        > this.manager.config.serverProcessPollIntervall
                ) {
                    this.tickRunning = true;
                    const cb = (): void => {
                        this.tickRunning = false;

                        // set lsat tick time (might be edited by tick itself)
                        this.lastTick = Math.max(
                            this.lastTick,
                            new Date().valueOf(),
                        );
                    };
                    this.tick().then(cb, cb);
                }
            },
            this.loopInterval,
        );
        this.log.log(LogLevel.IMPORTANT, 'Starting to watch server');
    }

    public async stop(): Promise<void> {
        if (!this.timers.getTimer('tick')) return;
        this.timers.removeAllTimers();
        this.eventBus.clear(InternalEventTypes.MONITOR_STATE_CHANGE);
        this.log.log(LogLevel.IMPORTANT, 'Stoping to watch server');
    }

    /**
     * Observation only - ServerZ owns starting the server (and restarting it on crash,
     * via its own exitWithChild + the container's restart policy), so this no longer
     * spawns anything itself. It just tracks/reports state and watches for a stuck
     * (running-but-frozen) server.
     */
    private async tick(): Promise<void> {
        if (this.manager.config.disableServerMonitoring || !this.manager.initDone) {
            return;
        }

        try {
            if (await this.serverDetector.isServerRunning()) {
                this.initialStart = false;
                this.log.log(LogLevel.INFO, 'Server running...');
                this.internalServerState = ServerState.STARTED;

                if (!this.manager.config.disableStuckCheck) {
                    await this.checkPossibleStuckState();
                }
            } else {
                this.internalServerState = ServerState.STOPPED;
                this.lastServerUsages = [];
            }
        } catch (e) {
            this.log.log(LogLevel.ERROR, 'Error during server monitor loop', e);
        }
    }

    public async checkPossibleStuckState(): Promise<boolean> {
        const processes = await this.serverDetector.getDayZProcesses();

        // no processes found, also means no process to be stuck
        if (!processes?.length) {
            this.lastServerUsages = [];
            return false;
        }

        if (this.lastServerUsages.length >= 5) {
            this.lastServerUsages.shift();
        }
        this.lastServerUsages.push(
            this.processes.getProcessCPUSpent(processes[0]),
        );

        if (this.lastServerUsages.length >= 5) {
            let avg = 0;
            for (const usage of this.lastServerUsages) {
                avg += usage;
            }
            avg /= this.lastServerUsages.length;
            this.log.log(LogLevel.DEBUG, `Dertermined server usage (avg, last 5): ${avg}, [${this.lastServerUsages.join(', ')}]`);
            // if the process spends very little cpu time, it probably got stuck
            if (this.lastServerUsages.every((x) => (Math.abs(avg - x) < 3))) {
                const msg = 'WARNING: Server possibly got stuck!';
                this.log.log(LogLevel.WARN, msg);
                this.eventBus.emit(
                    InternalEventTypes.DISCORD_MESSAGE,
                    {
                        type: 'admin',
                        message: msg,
                    },
                );
                return true;
            }
        }

        return false;
    }

    public skipLoop(forTime?: number): void {
        this.lastTick = new Date().valueOf() + (forTime ?? 30000);
    }

}

