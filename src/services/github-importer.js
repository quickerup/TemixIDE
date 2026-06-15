const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const logger = require('./logger');
const state = require('./state');

/**
 * Extracts TON smart contract files from a GitHub repository and creates a new session.
 * @param {string} repoUrl - The GitHub repository URL.
 * @param {string} sessionName - Optional session name.
 * @returns {Promise<{success: boolean, sessionName?: string, error?: string, fileCount?: number}>}
 */
async function importFromGitHub(repoUrl, sessionName = null) {
    const tempDir = path.join(process.cwd(), 'temp_import_' + Date.now());
    try {
        // Basic URL validation
        if (!repoUrl.includes('github.com')) {
            throw new Error('Please provide a valid GitHub repository URL.');
        }

        // Determine session name if not provided
        if (!sessionName) {
            sessionName = repoUrl.split('/').pop().replace('.git', '') || 'imported_repo';
        }

        logger.info(`Importing GitHub repo: ${repoUrl} into session: ${sessionName}`);

        // 1. Clone the repo (shallow)
        if (!fs.existsSync(tempDir)) fs.mkdirSync(tempDir, { recursive: true });
        
        try {
            // Using --depth 1 for speed and to avoid terminal prompts we use a timeout and pipe
            execSync(`git clone --depth 1 "${repoUrl}" .`, { 
                cwd: tempDir, 
                stdio: 'pipe',
                timeout: 30000 
            });
        } catch (e) {
            const err = e.stderr ? e.stderr.toString() : e.message;
            if (err.includes('Username for')) {
                throw new Error('Repository is private or requires authentication.');
            }
            throw new Error(`Failed to clone repository: ${err}`);
        }

        // 2. Create the session
        // If session exists, we append a timestamp to make it unique
        let finalSessionName = sessionName;
        let counter = 1;
        while (state.state.sessions[finalSessionName]) {
            finalSessionName = `${sessionName}_${counter++}`;
        }
        
        state.createSession(finalSessionName);
        const sessionPath = state.getSessionPath();

        // 3. Extract TON files recursively
        let fileCount = 0;
        const copyFiles = (dir, relBase = '') => {
            const items = fs.readdirSync(dir);
            for (const item of items) {
                const fullPath = path.join(dir, item);
                const relPath = path.join(relBase, item);
                
                if (fs.statSync(fullPath).isDirectory()) {
                    if (item !== '.git' && item !== 'node_modules' && item !== 'build') {
                        copyFiles(fullPath, relPath);
                    }
                } else if (item.endsWith('.tact') || item.endsWith('.fc') || item.endsWith('.func') || item.endsWith('.tolk')) {
                    const destPath = path.join(sessionPath, relPath);
                    fs.mkdirSync(path.dirname(destPath), { recursive: true });
                    fs.copyFileSync(fullPath, destPath);
                    fileCount++;
                }

            }
        };

        copyFiles(tempDir);

        if (fileCount === 0) {
            // Rollback session creation if no files found
            state.deleteSession(finalSessionName);
            throw new Error('No TON smart contract files (.tact, .fc, .func) found in the repository.');
        }

        return { success: true, sessionName: finalSessionName, fileCount };

    } catch (e) {
        logger.error('GitHub Import Error', '', e);
        return { success: false, error: e.message };
    } finally {
        // Cleanup temp directory
        if (fs.existsSync(tempDir)) {
            try {
                fs.rmSync(tempDir, { recursive: true, force: true });
            } catch (err) {
                logger.error('Cleanup failed during GitHub import', '', err);
            }
        }
    }
}

module.exports = {
    importFromGitHub
};
