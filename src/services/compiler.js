const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const logger = require('./logger');
const { getSensibleErrorReport } = require('./error-parser');
const { compileFunc: compileFuncLib } = require('@ton-community/func-js');
const { runTolkCompiler } = require('@ton/tolk-js');

function parseTactError(output) {
    const sensible = getSensibleErrorReport(output);
    if (sensible) return sensible;

    const lines = output.split('\n');
    const errorMarkers = [];
    for (let i = 0; i < lines.length; i++) {
        // Match standard Tact error format: file.tact:line:col: message
        const match = lines[i].match(/(.*?\.tact):(\d+):(\d+): (.*)/);
        if (match) {
            errorMarkers.push(`Line ${match[2]}, Col ${match[3]}: ${match[4]}`);
        }
    }
    return errorMarkers.length > 0 ? `Detailed Errors:\n${errorMarkers.join('\n')}` : output.slice(0, 1000);
}

function parseFuncError(output) {
    const lines = output.split('\n');
    const errorMarkers = [];
    for (let i = 0; i < lines.length; i++) {
        const match = lines[i].match(/(.*?\.fc|.*?\.func):(\d+):(\d+): (.*)/);
        if (match) {
            errorMarkers.push(`Line ${match[2]}, Col ${match[3]}: ${match[4]}`);
        }
    }
    return errorMarkers.length > 0 ? `Detailed FunC Errors:\n${errorMarkers.join('\n')}` : output.slice(0, 1000);
}

function parseTolkError(output) {
    // Tolk errors usually have a similar format
    const lines = output.split('\n');
    const errorMarkers = [];
    for (let i = 0; i < lines.length; i++) {
        const match = lines[i].match(/(.*?\.tolk):(\d+):(\d+): (.*)/);
        if (match) {
            errorMarkers.push(`Line ${match[2]}, Col ${match[3]}: ${match[4]}`);
        }
    }
    return errorMarkers.length > 0 ? `Detailed Tolk Errors:\n${errorMarkers.join('\n')}` : output.slice(0, 1000);
}

function extractContractName(code) {
    // Basic detection for various languages
    const tactMatch = code.match(/contract\s+([a-zA-Z0-9]+)/);
    if (tactMatch) return tactMatch[1];
    
    // For FunC/Tolk, we might not have a "contract" keyword, so we use the filename
    return 'Generated';
}

/**
 * Strategy-based compilation
 */
const compilers = {
    '.tact': compileTact,
    '.fc': compileFunc,
    '.func': compileFunc,
    '.tolk': compileTolk
};

async function compile(fileName, sessionPath) {
    const ext = path.extname(fileName).toLowerCase();
    const compiler = compilers[ext];
    
    if (!compiler) {
        throw new Error(`No compiler registered for extension: ${ext}`);
    }

    const source = fs.readFileSync(path.join(sessionPath, fileName), 'utf8');
    return await compiler(source, fileName, sessionPath);
}

async function compileTact(source, fileName, sessionPath) {
    const t0 = Date.now();
    const tempConfigPath = path.join(sessionPath, `temp_${fileName}.json`);
    const projectName = `Target_${fileName.replace('.tact', '')}`;
    const buildDir = path.join(sessionPath, 'build');
    
    const tempConfig = {
        projects: [{
            name: projectName,
            path: `./${fileName}`,
            output: './build',
            options: { debug: true, external: true }
        }]
    };
    fs.writeFileSync(tempConfigPath, JSON.stringify(tempConfig));

    try {
        execSync(`npx tact --config "temp_${fileName}.json" 2>&1`, { cwd: sessionPath, stdio: 'pipe', timeout: 60000 });
        const dur = Date.now() - t0;
        const artifacts = fs.existsSync(buildDir) ? fs.readdirSync(buildDir).filter(f => f.startsWith(projectName)) : [];
        const firstContract = artifacts.find(a => a.endsWith('.code.boc'));
        const baseName = firstContract ? firstContract.replace('.code.boc', '') : projectName;
        
        return { success: true, baseName, dur, artifacts, language: 'Tact' };
    } catch (e) {
        const err = e.stdout ? e.stdout.toString('utf8') : e.message;
        return { success: false, error: parseTactError(err), language: 'Tact' };
    } finally {
        if (fs.existsSync(tempConfigPath)) fs.unlinkSync(tempConfigPath);
    }
}

async function compileFunc(source, fileName, sessionPath) {
    const t0 = Date.now();
    try {
        const sources = {};
        const getAllFiles = (dir, base = '') => {
            const list = fs.readdirSync(dir);
            list.forEach(file => {
                const fullPath = path.join(dir, file);
                const relPath = path.join(base, file);
                if (fs.statSync(fullPath).isDirectory()) {
                    if (file !== 'build' && file !== 'node_modules') {
                        getAllFiles(fullPath, relPath);
                    }
                } else if (file.endsWith('.fc') || file.endsWith('.func') || file.endsWith('.tolk')) {
                    sources[relPath] = fs.readFileSync(fullPath, 'utf8');
                }
            });
        };
        getAllFiles(sessionPath);
        
        if (!sources[fileName]) sources[fileName] = source;

        const result = await compileFuncLib({
            targets: [fileName],
            sources: sources
        });

        if (result.status === 'error') {
            return { success: false, error: parseFuncError(result.message), language: 'FunC' };
        }

        const buildDir = path.join(sessionPath, 'build');
        if (!fs.existsSync(buildDir)) fs.mkdirSync(buildDir, { recursive: true });

        const baseName = fileName.replace(/\.(fc|func)$/, '').split('/').pop();
        const codeBoc = Buffer.from(result.codeBoc, 'base64');
        fs.writeFileSync(path.join(buildDir, `${baseName}.code.boc`), codeBoc);
        
        return { success: true, baseName, dur: Date.now() - t0, language: 'FunC' };
    } catch (e) {
        return { success: false, error: e.message, language: 'FunC' };
    }
}

async function compileTolk(source, fileName, sessionPath) {
    const t0 = Date.now();
    try {
        const sources = {};
        const getAllFiles = (dir, base = '') => {
            const list = fs.readdirSync(dir);
            list.forEach(file => {
                const fullPath = path.join(dir, file);
                const relPath = path.join(base, file);
                if (fs.statSync(fullPath).isDirectory()) {
                    if (file !== 'build' && file !== 'node_modules') {
                        getAllFiles(fullPath, relPath);
                    }
                } else if (file.endsWith('.tolk') || file.endsWith('.fc') || file.endsWith('.func')) {
                    sources[relPath] = fs.readFileSync(fullPath, 'utf8');
                }
            });
        };
        getAllFiles(sessionPath);
        
        if (!sources[fileName]) sources[fileName] = source;

        const result = await runTolkCompiler(fileName, (path) => sources[path] || null);

        if (result.status === 'error') {
            return { success: false, error: parseTolkError(result.message), language: 'Tolk' };
        }

        const buildDir = path.join(sessionPath, 'build');
        if (!fs.existsSync(buildDir)) fs.mkdirSync(buildDir, { recursive: true });

        const baseName = fileName.replace('.tolk', '').split('/').pop();
        const codeBoc = Buffer.from(result.codeBoc, 'base64');
        fs.writeFileSync(path.join(buildDir, `${baseName}.code.boc`), codeBoc);
        
        return { success: true, baseName, dur: Date.now() - t0, language: 'Tolk' };
    } catch (e) {
        return { success: false, error: e.message, language: 'Tolk' };
    }
}

async function compileSilent(code, fileName, sessionPath) {
    // Simplification for silent verification
    try {
        const ext = path.extname(fileName).toLowerCase();
        if (ext === '.tact') {
            // Keep the Tact silent compile as it was specialized
            const tempFile = path.join(sessionPath, fileName);
            fs.writeFileSync(tempFile, code);
            const projectName = `Verify_${fileName.replace('.tact', '').replace(/[^a-zA-Z0-9]/g, '_')}`;
            const buildVerifyDir = path.join(sessionPath, 'build_verify');
            if (!fs.existsSync(buildVerifyDir)) fs.mkdirSync(buildVerifyDir, { recursive: true });
            const tempConfigPath = path.join(sessionPath, `temp_verify_${fileName}.json`);
            const tempConfig = { projects: [{ name: projectName, path: `./${fileName}`, output: './build_verify', options: { debug: true, external: true } }] };
            fs.writeFileSync(tempConfigPath, JSON.stringify(tempConfig));
            try {
                execSync(`npx tact --config "temp_verify_${fileName}.json" 2>&1`, { cwd: sessionPath, stdio: 'pipe', timeout: 60000 });
                const abiPath = path.join(buildVerifyDir, `${projectName}.abi`);
                let abi = fs.existsSync(abiPath) ? JSON.parse(fs.readFileSync(abiPath, 'utf8')) : null;
                return { success: true, abi };
            } finally {
                if (fs.existsSync(tempConfigPath)) fs.unlinkSync(tempConfigPath);
                if (fs.existsSync(tempFile)) fs.unlinkSync(tempFile);
                if (fs.existsSync(buildVerifyDir)) fs.rmSync(buildVerifyDir, { recursive: true, force: true });
            }
        } else {
            // For FunC/Tolk, silent compile is just compile without saving build dir (or just reusing it)
            const result = await compile(fileName, sessionPath);
            return { success: result.success, error: result.error };
        }
    } catch (e) {
        return { success: false, error: e.message };
    }
}

let compileQueue = Promise.resolve();
function queueCompileTask(task) {
  const run = compileQueue.then(task, task);
  compileQueue = run.catch((e) => {
    logger.error('Queue task failed', '', e);
  });
  return run;
}

module.exports = {
    parseTactError,
    parseFuncError,
    parseTolkError,
    extractContractName,
    compileSilent,
    compile,
    compileTact,
    compileFunc,
    compileTolk,
    queueCompileTask
};
