#!/usr/bin/env node
/**
 * Conditional PBO build script
 * Skips PBO building on Linux (makepbo is Windows-only)
 */

const { execSync, spawnSync } = require('child_process');
const os = require('os');
const fs = require('fs');
const path = require('path');

const isWindows = os.platform() === 'win32';

// Check if makepbo is available
function hasMakePbo() {
    try {
        const result = spawnSync(isWindows ? 'where' : 'which', ['makepbo'], { 
            stdio: 'pipe',
            shell: false,
            encoding: 'utf8'
        });
        return result.status === 0 && result.stdout && result.stdout.trim().length > 0;
    } catch {
        return false;
    }
}

const pboConfigs = [
    {
        name: '@DayZServerManager',
        src: 'watcher_mod/DayZServerManager/Scripts',
        dest: 'dist/mods/@DayZServerManager/addons/scripts.pbo',
        prefix: 'DayZServerManager/Scripts'
    },
    {
        name: '@DayZServerManagerExpansion', 
        src: 'watcher_mod/DayZServerManagerExpansion/Scripts',
        dest: 'dist/mods/@DayZServerManagerExpansion/addons/scripts.pbo',
        prefix: 'DayZServerManagerExpansion/Scripts'
    },
    {
        name: '@DayZServerManagerSyberia',
        src: 'watcher_mod/DayZServerManagerSyberia/Scripts', 
        dest: 'dist/mods/@DayZServerManagerSyberia/addons/scripts.pbo',
        prefix: 'DayZServerManagerSyberia/Scripts'
    }
];

function buildPbos() {
    const makePboAvailable = hasMakePbo();
    
    if (!makePboAvailable) {
        console.log('⚠️  Skipping PBO build: makepbo not available on this platform');
        console.log('   PBO files are only required for DayZ mod functionality');
        console.log('   The server manager will work without them for development');
        
        // Create empty placeholder directories
        for (const config of pboConfigs) {
            const dir = path.dirname(config.dest);
            if (!fs.existsSync(dir)) {
                fs.mkdirSync(dir, { recursive: true });
                console.log(`   Created placeholder: ${dir}`);
            }
        }
        return;
    }

    console.log('Building PBO files...');
    
    for (const config of pboConfigs) {
        const dir = path.dirname(config.dest);
        if (!fs.existsSync(dir)) {
            fs.mkdirSync(dir, { recursive: true });
        }

        if (!fs.existsSync(config.src)) {
            console.log(`⚠️  Skipping ${config.name}: source not found`);
            continue;
        }

        try {
            const cmd = `makepbo -P -@=${config.prefix} ${config.src} ${config.dest}`;
            console.log(`Building ${config.name}...`);
            execSync(cmd, { stdio: 'inherit', shell: true });
            console.log(`✓ Built ${config.name}`);
        } catch (e) {
            console.error(`✗ Failed to build ${config.name}: ${e.message}`);
        }
    }
}

buildPbos();
