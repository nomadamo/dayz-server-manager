import * as path from 'path';
import * as extract from 'extract-zip';
import * as tar from 'tar';
import { FSAPI, HTTPSAPI, InjectionTokens } from '../util/apis';
import { inject, injectable, singleton } from 'tsyringe';

@singleton()
@injectable()
export class Downloader {

    public constructor(
        @inject(InjectionTokens.fs) private fs: FSAPI,
        @inject(InjectionTokens.https) private http: HTTPSAPI,
    ) {}

    public async download(
        url: string,
        target: string,
    ): Promise<void> {
        const dirname = path.dirname(target);
        await this.fs.promises.mkdir(dirname, { recursive: true });

        return new Promise<void>((res, rej) => {
            try {
                const file = this.fs.createWriteStream(target);
                this.http.get(
                    url,
                    (response) => {
                        response.pipe(file);
                        file.on('finish', () => {
                            file.close();
                            res();
                        });
                    },
                ).on('error', (e) => {
                    rej(e);
                });
            } catch (e) {
                rej(e);
            }
        });
    }

    /* istanbul ignore next */
    public extractZip(zip: string, toDir: string): Promise<void> {
        return (extract as any)(zip, { dir: toDir });
    }

    /* istanbul ignore next */
    public extractTar(tarPath: string, toDir: string): Promise<void> {
        return tar.extract(
            {
                file: tarPath,
                cwd: toDir,
            },
        );
    }

}
