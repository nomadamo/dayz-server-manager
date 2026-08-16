import * as path from 'path';
import * as commentJson from 'comment-json';
import { LogLevel } from '../util/logger';
import { Paths } from '../services/paths';
import { Config } from './config';
import { generateConfigTemplate } from './config-template';
import { parseConfigFileContent, validateConfig } from './config-validate';
import { inject, injectable, singleton } from 'tsyringe';
import { FSAPI, InjectionTokens } from '../util/apis';
import { IService } from '../types/service';
import { LoggerFactory } from '../services/loggerfactory';
import { origExit } from '../util/exit-capture';
import { randomUUID } from 'crypto';
import { detectOS } from '../util/detect-os';

// eslint-disable-next-line @typescript-eslint/no-var-requires
const configschema = require('./config.schema.json');

@singleton()
@injectable()
export class ConfigFileHelper extends IService {

    public static readonly CFG_NAME = 'server-manager.json';

    public constructor(
        loggerFactory: LoggerFactory,
        private paths: Paths,
        @inject(InjectionTokens.fs) private fs: FSAPI,
    ) {
        super(loggerFactory.createLogger('Config'));
    }

    public getConfigFilePath(): string {
        return path.join(this.paths.cwd(), ConfigFileHelper.CFG_NAME);
    }

    public async getConfigFileContent(cfgPath: string): Promise<string> {
        try {
            await this.fs.promises.access(cfgPath);
            return this.fs.promises.readFile(cfgPath, { encoding: 'utf-8' });
        } catch {
            throw new Error('Config file does not exist');
        }
    }

    private logConfigErrors(errors: string[]): void {
        this.log.log(LogLevel.ERROR, 'Config has errors:');

        for (const configError of errors) {
            this.log.log(LogLevel.ERROR, configError);
        }
    }

    /**
     * Path to ServerZ's generated shared-config.json (rcon creds, paths, serverCfg block),
     * set by ServerZ when it spawns this process. When unset (i.e. not running as a
     * ServerZ child), no merge happens - server-manager.json alone is authoritative,
     * same as before.
     */
    private getSharedConfigPath(): string | undefined {
        return process.env.SERVERZ_SHARED_CONFIG_PATH || undefined;
    }

    private async readSharedConfig(): Promise<Partial<Config> | null> {
        const sharedPath = this.getSharedConfigPath();
        if (!sharedPath) {
            return null;
        }

        try {
            await this.fs.promises.access(sharedPath);
        } catch {
            this.log.log(LogLevel.WARN, `SERVERZ_SHARED_CONFIG_PATH is set to "${sharedPath}", but the file was not found. Skipping shared config merge.`);
            return null;
        }

        try {
            const content = await this.fs.promises.readFile(sharedPath, { encoding: 'utf-8' });
            return commentJson.parse(content) as any as Partial<Config>;
        } catch (e) {
            this.log.log(LogLevel.ERROR, `Failed to read/parse shared config at "${sharedPath}": ${e.message}`, e);
            return null;
        }
    }

    /**
     * @param persistSharedMerge When true and a shared config was actually merged in,
     * writes the merged result back to server-manager.json - so the Settings page
     * (which edits/displays that file directly) shows the real values actually in use,
     * not stale ones from before the last merge. Only pass true from a one-time boot
     * read, never from the config-watcher's reload path: writing here changes the
     * file's mtime, which the watcher also watches, and doing it on every reload would
     * self-trigger another reload indefinitely.
     */
    public async readConfig(persistSharedMerge = false): Promise<Config | null> {
        let fileContent: string;
        try {
            const cfgPath = this.getConfigFilePath();
            this.log.log(LogLevel.IMPORTANT, `Trying to read config at: ${cfgPath}`);
            fileContent = await this.getConfigFileContent(cfgPath);

            // apply defaults, then the user's own config on top
            let parsed = commentJson.assign(
                new Config(),
                parseConfigFileContent(fileContent),
            );

            // then ServerZ's shared config on top of that - it's the single source of
            // truth for anything it also uses to actually run the server, so it always
            // wins over whatever's in server-manager.json for these specific fields.
            const shared = await this.readSharedConfig();
            if (shared) {
                parsed = commentJson.assign(parsed, shared);
                this.log.log(LogLevel.IMPORTANT, 'Merged shared config from ServerZ');

                if (persistSharedMerge) {
                    try {
                        await this.fs.promises.writeFile(
                            cfgPath,
                            commentJson.stringify(parsed, null, 2),
                        );
                    } catch (e) {
                        this.log.log(LogLevel.WARN, `Failed to persist merged config to ${cfgPath} (in-memory config is still correct): ${e.message}`, e);
                    }
                }
            }

            const configErrors = validateConfig(parsed);
            if (configErrors?.length) {
                this.logConfigErrors(configErrors);

                return null;
            }

            this.log.log(LogLevel.IMPORTANT, 'Successfully read config');

            return parsed;
        } catch (e) {
            this.log.log(LogLevel.ERROR, `Error reading config: ${e.message}`, e);
            return null;
        }
    }

    public async writeConfig(newConfig: string): Promise<void> {
        // apply defaults
        const config = commentJson.assign(
            (await this.readConfig()) || commentJson.parse(generateConfigTemplate(configschema)) as any as Config,
            commentJson.parse(newConfig) as any as Config,
        );

        const configErrors = validateConfig(config);
        if (configErrors?.length) {
            throw ['New config contains errors. Cannot replace config.', ...configErrors];
        }

        try {
            await this.fs.promises.writeFile(
                this.getConfigFilePath(),
                commentJson.stringify(config, null, 2),
            );
        } catch (e) {
            throw [`Error generating / writing config (${e?.message ?? 'Unknown'}). Cannot replace config.`];
        }
    }

    public async createDefaultConfig(): Promise<void> {

        const cfgPath = this.getConfigFilePath();

        try {
            await this.fs.promises.access(cfgPath);
        } catch {
            const defaultConfig = commentJson.parse(generateConfigTemplate(configschema)) as any as Config;

            // apply safe defaults
            defaultConfig.admins[0].password = randomUUID();
            defaultConfig.ingameApiKey = randomUUID();
            defaultConfig.rconPassword = randomUUID();
            defaultConfig.serverCfg.passwordAdmin = randomUUID();

            // linux specifics
            if (detectOS() !== 'windows') {
                defaultConfig.serverExe = 'DayZServer';
            }

            await this.fs.promises.writeFile(
                cfgPath,
                commentJson.stringify(defaultConfig, null, 2),
            );

            console.log('\n\n\n');
            console.log('Did not find a server manager config!');
            console.log(`Created a new config with default values at: ${cfgPath}`);
            console.log('Adjust the config to fit your needs and restart the manager!');
            console.log('\n\n');

            if (typeof global.it === 'function') {
                return;
            }
            origExit(0); // end process
        }

    }

}
