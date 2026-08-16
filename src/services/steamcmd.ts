import * as path from 'path';
import { Manager } from '../control/manager';
import { Paths } from '../services/paths';
import { LogLevel } from '../util/logger';
import { IService } from '../types/service';
import { inject, injectable, singleton } from 'tsyringe';
import { LoggerFactory } from './loggerfactory';
import { FSAPI, HTTPSAPI, InjectionTokens } from '../util/apis';
import { merge } from '../util/merge';
import { request } from '../util/request';
import { LocalMetaData, PublishedFileDetail, SteamApiWorkshopItemDetailsResponse } from '../types/steamcmd';

// Note: this file used to also contain the SteamCMD class, which owned
// downloading/installing/updating the server and mods via SteamCMD directly.
// That's now ServerZ's job (see the shared-config.json integration) - only
// SteamMetaData survives, since it's just Steam Web API lookups (mod names,
// sizes, update timestamps for display/Discord notifications), independent
// of SteamCMD or who owns the actual install.

@singleton()
@injectable()
export class SteamMetaData extends IService {

    private gameLastCheck: number;
    private gameMetaData: PublishedFileDetail[];

    private workshopMetaData: Map<string, { lastCheck: number; data: PublishedFileDetail }> = new Map();

    public constructor(
        loggerFactory: LoggerFactory,
        private manager: Manager,
        private paths: Paths,
        @inject(InjectionTokens.fs) private fs: FSAPI,
        @inject(InjectionTokens.https) private https: HTTPSAPI,
    ) {
        super(loggerFactory.createLogger('SteamAPI'));
    }

    private getMetaDataPath(): string {
        let metaFolder = this.manager.config?.steamMetaPath ?? '';
        if (!this.paths.isAbsolute(metaFolder)) {
            metaFolder = path.join(this.paths.cwd(), metaFolder);
        }
        return metaFolder;
    }

    public async readLocalMeta(modId: string): Promise<LocalMetaData> {
        const metaPath = path.join(this.getMetaDataPath(), `${modId}.json`);
        try {
            await this.fs.promises.access(metaPath);
        } catch {
            return {};
        }
        try {
            return JSON.parse(
                await this.fs.promises.readFile(metaPath, { encoding: 'utf-8' }),
            );
        } catch {}
        return {};
    }

    public async writeLocalMeta(modId: string, data: LocalMetaData): Promise<void> {
        await this.fs.promises.mkdir(this.getMetaDataPath(), { recursive: true });
        const modMetaPath = path.join(this.getMetaDataPath(), `${modId}.json`);
        await this.fs.promises.writeFile(modMetaPath, JSON.stringify(data));
    }

    public async updateLocalModMeta(modId: string, update: LocalMetaData): Promise<void> {
        await this.writeLocalMeta(
            modId,
            merge(
                await this.readLocalMeta(modId),
                update,
            ),
        );
    }

    public async modNeedsUpdate(modIds: string[]): Promise<string[]> {
        const remoteList = await this.getModsMetaData(modIds);
        const results = await Promise.all(modIds.map(async (modId) => {
            const local = (await this.readLocalMeta(modId))?.lastDownloaded;
            if (!local || !Number(local)) {
                return true;
            }
            const remote = remoteList.find((x) => x.publishedfileid === modId);
            const remoteTime = Number(remote?.time_updated || remote?.time_created || 0);
            const localTime = Math.round(Number(local) / 1000);
            return !remoteTime || localTime <= remoteTime;
        }));
        return modIds.filter((_, i) => results[i]);
    }

    public async getModsMetaData(modIds: string[]): Promise<PublishedFileDetail[]> {
        if (!modIds?.length) {
            return [];
        }

        const modInfos: PublishedFileDetail[] = [];
        const requireUpdate: string[] = [];

        for (const modId of modIds) {
            const cache = this.workshopMetaData.get(modId);
            if (cache?.lastCheck && (new Date().valueOf() - cache.lastCheck) < 60000) {
                modInfos.push(cache.data);
            } else {
                requireUpdate.push(modId);
            }
        }

        if (requireUpdate?.length) {
            const response = (await this.requestWorkshopItemDetails(requireUpdate))?.response?.publishedfiledetails || [];
            for (const responseItem of response) {
                this.workshopMetaData.set(
                    responseItem.publishedfileid,
                    {
                        lastCheck: new Date().valueOf(),
                        data: responseItem,
                    },
                );
                modInfos.push(responseItem);
            }
        }

        return [...modInfos];
    }

    public async requestWorkshopItemDetails(ids: string[]): Promise<SteamApiWorkshopItemDetailsResponse | null> {
        try {

            const formData = new URLSearchParams();
            formData.append('format', 'json');
            formData.append('itemcount', `${ids.length}`);
            ids.forEach((x, i) => {
                formData.append(`publishedfileids[${i}]`, `${x}`);
            });

            const response = await request(
                this.https,
                'https://api.steampowered.com/ISteamRemoteStorage/GetPublishedFileDetails/v1/',
                {
                    method: 'POST',
                    body: formData.toString(),
                    headers: {
                        // eslint-disable-next-line @typescript-eslint/naming-convention
                        'Content-Type': 'application/x-www-form-urlencoded',
                    },
                },
            );

            if (response.statusCode !== 200) {
                this.log.log(
                    LogLevel.WARN,
                    `Failed to request workshop details of ${ids}, because of http error: ${response.statusCode} (${response.statusMessage})`,
                );
                return null;
            }

            return JSON.parse(response.body);
        } catch (e) {
            this.log.log(LogLevel.WARN, `Failed to request workshop details of ${ids}`, e);
            return null;
        }
    }

}
