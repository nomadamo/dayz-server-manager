import * as crypto from 'crypto';
import * as chokidarModule from 'chokidar';
import { injectable, inject, singleton, registry } from 'tsyringe';
import { ConfigFileHelper } from '../config/config-file-helper';
import { LogLevel } from '../util/logger';
import { Config } from '../config/config';
import { IService } from '../types/service';
import { LoggerFactory } from './loggerfactory';
import { CHOKIDAR, InjectionTokens } from '../util/apis';

export type ConfigCallback = (config: Config) => any;

@singleton()
@registry([{
    token: InjectionTokens.chokidar,
    useValue: chokidarModule,
}]) // eslint-disable-line @typescript-eslint/indent
@injectable()
export class ConfigWatcher extends IService {

    private changeDetectionDelay = 1000;

    private configFileWatcher: chokidarModule.FSWatcher | undefined;
    private configFileHash: string | undefined;

    public constructor(
        loggerFactory: LoggerFactory,
        @inject(InjectionTokens.chokidar) private chokidar: CHOKIDAR,
        private configFileHelper: ConfigFileHelper,
    ) {
        super(loggerFactory.createLogger('ConfigWatcher'));
    }

    public async watch(cb: ConfigCallback): Promise<Config> {
        const cfgPath = this.configFileHelper.getConfigFilePath();
        // also watch ServerZ's generated shared config (if any), so a restart there
        // (which regenerates it) triggers a reload here too, same as editing
        // server-manager.json directly does.
        const sharedCfgPath = process.env.SERVERZ_SHARED_CONFIG_PATH;
        const watchPaths = sharedCfgPath ? [cfgPath, sharedCfgPath] : [cfgPath];

        const config = await this.configFileHelper.readConfig();
        if (!config) {
            throw new Error(`Config missing or invalid`);
        }

        this.configFileHash = crypto.createHash('md5')
            .update(JSON.stringify(config))
            .digest('hex');

        const onFileEvent = /* istanbul ignore next */ async () => { // NOSONAR
            // usually file "headers" are saved before content is done
            // waiting a small amount of time prevents reading RBW errors
            await new Promise((r) => setTimeout(r, this.changeDetectionDelay));

            await this.checkForChange(cb);
        };

        this.configFileWatcher = this.chokidar.watch(
            watchPaths,
        ).on(
            'change',
            onFileEvent,
        ).on(
            // ServerZ's shared config doesn't exist yet when watching starts (this
            // process is deliberately started before ServerZ generates it) - its
            // first appearance is an 'add' event, not 'change'.
            'add',
            onFileEvent,
        );

        return config;
    }

    public async checkForChange(cb: ConfigCallback): Promise<void> {
        this.log.log(LogLevel.INFO, 'Detected config file change...');

        const updatedConfig = await this.configFileHelper.readConfig();
        if (!updatedConfig) {
            this.log.log(LogLevel.ERROR, 'Cannot reload config because config is missing or contains errors');
            return;
        }

        const newHash = crypto.createHash('md5')
            .update(JSON.stringify(updatedConfig))
            .digest('hex');

        if (newHash === this.configFileHash) {
            this.log.log(LogLevel.WARN, 'Skipping config reload because no changes were found');
            return;
        }

        cb(updatedConfig);
    }

    public async stopWatching(): Promise<void> {
        if (this.configFileWatcher) {
            await this.configFileWatcher.close();
            this.configFileWatcher = undefined;
        }
    }

}
