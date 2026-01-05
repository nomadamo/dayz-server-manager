import * as path from 'path';
import { LogLevel } from '../util/logger';
import { detectOS } from '../util/detect-os';
import { inject, injectable, singleton } from 'tsyringe';
import { CHILDPROCESSAPI, FSAPI, InjectionTokens } from '../util/apis';
import { IService } from '../types/service';
import { LoggerFactory } from './loggerfactory';

export const copyAsync = async (fs: FSAPI, source: string, target: string): Promise<void> => {

    // src=somedir/test target=tmp -> tmp/test
    const stat = await fs.promises.lstat(source);
    if (stat.isDirectory()) {
        try {
            await fs.promises.access(target);
        } catch {
            await fs.promises.mkdir(target, { recursive: true });
        }
        const files = await fs.promises.readdir(source);
        for (const file of files) {
            const curSource = path.join(source, file);
            const curTarget = path.join(target, file);
            const curStat = await fs.promises.lstat(curSource);
            if (curStat.isDirectory()) {
                await copyAsync(fs, curSource, curTarget);
            } else {
                await fs.promises.copyFile(curSource, curTarget);
            }
        }
    } else {
        try {
            await fs.promises.access(target);
        } catch {
            await fs.promises.mkdir(target, { recursive: true });
        }
        await fs.promises.copyFile(source, path.join(target, path.basename(source)));
    }
};

@singleton()
@injectable()
export class Paths extends IService {

    private workingDir: string = process.cwd();

    public constructor(
        loggerFactory: LoggerFactory,
        @inject(InjectionTokens.fs) private fs: FSAPI,
        @inject(InjectionTokens.childProcess) private childProcess: CHILDPROCESSAPI,
    ) {
        super(loggerFactory.createLogger('Paths'));
    }

    /* istanbul ignore next */
    public setCwd(workingDir: string): void {
        this.workingDir = workingDir;
    }

    /* istanbul ignore next */
    public cwd(): string {
        return this.resolve(this.workingDir);
    }

    /* istanbul ignore next */
    public resolve(...parts: string[]): string {
        if (this.isAbsolute(parts[0])) {
            return path.join(...parts);
        }
        return path.resolve(...parts);
    }

    /* istanbul ignore next */
    public isAbsolute(fspath: string): boolean {
        // absolute windows paths are not detected on linux
        return path.isAbsolute(fspath) || /^[a-zA-Z]:[/\\].*/.test(fspath);
    }

    public samePath(p1: string, p2: string): boolean {

        if (!p1 || !p2) return false;

        const p1Norm = p1
            .replace(/\\/g, '/')
            .toLowerCase()
            .split('/');
        const p2Norm = p2
            .replace(/\\/g, '/')
            .toLowerCase()
            .split('/');

        return (
            (p1Norm.length === p2Norm.length)
            && p1Norm.every((val, i) => val === p2Norm[i])
        );
    }

    public async findFilesInDir(dir: string, filter?: RegExp): Promise<string[]> {
        const results: string[] = [];

        try {
            await this.fs.promises.access(dir);
        } catch {
            return results;
        }

        const files = await this.fs.promises.readdir(dir);
        for (const file of files) {
            const filename = path.join(dir, file);
            const stat = await this.fs.promises.lstat(filename);
            if (stat.isDirectory()) {
                results.push(...(await this.findFilesInDir(filename, filter)));
            } else if (!filter || filter.test(filename)) {
                results.push(filename);
            }
        }
        return results;
    }

    // https://github.com/vercel/pkg/issues/420
    public async copyFromPkg(src: string, dest: string): Promise<void> {
        const stat = await this.fs.promises.lstat(src);
        if (stat.isDirectory()) {
            const files = await this.fs.promises.readdir(src);
            for (const file of files) {
                const fullPath = path.join(src, file);
                const fullDest = path.join(dest, file);
                await this.copyFromPkg(fullPath, fullDest);
            }
        } else {
            await this.fs.promises.mkdir(path.dirname(dest), { recursive: true });
            const buff = await this.fs.promises.readFile(src);
            await this.fs.promises.writeFile(dest, buff as any);
        }
    }

    public async removeLink(target: string): Promise<boolean> {
        if (detectOS() === 'windows') {
            // cmd //c rmdir "$__TARGET_DIR"
            return new Promise<boolean>((resolve) => {
                const child = this.childProcess.spawn(
                    'cmd',
                    [
                        '/c',
                        'rmdir',
                        '/S',
                        '/Q',
                        target,
                    ]
                );
                child.on('exit', (code) => resolve(code === 0));
                child.on('error', () => resolve(false));
            });
        }

        if (detectOS() === 'linux') {

            try {
                const stats = await this.fs.promises.lstat(target);
                if (stats.isSymbolicLink()) {
                    await this.fs.promises.unlink(target);
                } else if (stats.isDirectory()) {
                    await this.fs.promises.rm(
                        target,
                        {
                            recursive: true,
                        },
                    );
                } else {
                    await this.fs.promises.rm(target);
                }
            } catch {
                return false;
            }

            return true;
        }

        return false;
    }

    public async linkDirsFromTo(source: string, target: string): Promise<boolean> {
        if (detectOS() === 'windows') {
            // cmd //c mklink //j "$__TARGET_DIR" "$__SOURCE_DIR"
            try {
                try {
                    await this.fs.promises.access(target);
                    if (!await this.removeLink(target)) {
                        this.log.log(LogLevel.ERROR, 'Could not remove link before creating new one');
                        return false;
                    }
                } catch {}
                
                return new Promise<boolean>((resolve) => {
                    const child = this.childProcess.spawn(
                        'cmd',
                        [
                            '/c',
                            'mklink',
                            '/j',
                            target,
                            source,
                        ]
                    );
                    child.on('exit', (code) => resolve(code === 0));
                    child.on('error', (e) => {
                        this.log.log(LogLevel.ERROR, `Error linking ${source} to ${target}`, e);
                        resolve(false)
                    });
                });
            } catch (e) {
                this.log.log(LogLevel.ERROR, `Error linking ${source} to ${target}`, e);
                return false;
            }
        }

        if (detectOS() === 'linux') {
            try {
                try {
                    await this.fs.promises.access(target);
                    if (!await this.removeLink(target)) {
                        this.log.log(LogLevel.ERROR, 'Could not remove link before creating new one');
                        return false;
                    }
                } catch {}
                await this.fs.promises.symlink(source, target);
                return true;
            } catch (e) {
                this.log.log(LogLevel.ERROR, `Error linking ${source} to ${target}`, e);
                return false;
            }
        }

        return false;
    }

    public async copyDirFromTo(source: string, target: string): Promise<boolean> {
        try {
            try {
                await this.fs.promises.access(target);
                if (!await this.removeLink(target)) {
                    this.log.log(LogLevel.ERROR, 'Could not remove dir before creating new one');
                    return false;
                }
            } catch {}

            await copyAsync(this.fs, source, target);

            return true;
        } catch (e) {
            this.log.log(LogLevel.ERROR, `Error copying ${source} to ${target}`, e);
            return false;
        }
    }

}

