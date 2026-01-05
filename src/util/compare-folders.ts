import * as folderHashModule from 'folder-hash';
import { FSAPI } from './apis';

export const sameDirHash = async (
    fs: FSAPI,
    dir1: string,
    dir2: string,
): Promise<boolean> => {
    try {
        await fs.promises.access(dir1);
        await fs.promises.access(dir2);
    } catch {
        return false;
    }

    // eslint-disable-next-line @typescript-eslint/dot-notation
    const folderHash = folderHashModule['prep'](fs) as typeof folderHashModule.hashElement;

    const hashes = await Promise.all([
        folderHash(dir1, { folders: { ignoreRootName: true } }),
        folderHash(dir2, { folders: { ignoreRootName: true } }),
    ]);
    return hashes[0]?.hash && (hashes[0]?.hash === hashes[1]?.hash);
};
