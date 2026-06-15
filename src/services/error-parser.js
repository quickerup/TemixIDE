/**
 * Robust HTML escaping for Telegram messages.
 */
function escapeHTML(str) {
    return String(str || '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#039;');
}

/**
 * Error Rubric and Correction Matrix for Tact Compiler
 * Provides human-readable explanations and suggested fixes for common Tact errors.
 */
const ERROR_RUBRIC = [
    {
        pattern: /Type\s+"(.*?)"\s+does\s+not\s+have\s+a\s+function\s+named\s+"(.*?)"/i,
        reason: (match) => `You're trying to call <code>${escapeHTML(match[2])}()</code> on a value that is an <b>${escapeHTML(match[1])}</b>.`,
        expected: (match) => `A valid function name or method for type "${escapeHTML(match[1])}"`,
        received: (match) => escapeHTML(match[2]),
        tip: (match, file, line) => {
            if (match[2] === 'unwrapOr') return `In Tact, use the null-coalescing operator <code>??</code> for default values (e.g., <code>value ?? 0</code>).`;
            return `Check the Tact documentation for <b>${escapeHTML(match[1])}</b> methods or check for typos.`;
        }
    },
    {
        pattern: /Type\s+'(.*?)'\s+is\s+not\s+assignable\s+to\s+type\s+'(.*?)'/i,
        reason: (match) => `Type mismatch: A <b>${escapeHTML(match[1])}</b> cannot be used where an <b>${escapeHTML(match[2])}</b> is expected.`,
        expected: (match) => escapeHTML(match[2]),
        received: (match) => escapeHTML(match[1]),
        tip: (match) => `Check if you need to convert the value or if the variable declaration type is correct.`
    },
    {
        pattern: /Variable\s+'(.*?)'\s+is\s+not\s+found/i,
        reason: (match) => `The compiler can't find anything named <code>${escapeHTML(match[1])}</code> in this scope.`,
        expected: (match) => `A declared variable, constant, or parameter`,
        received: (match) => escapeHTML(match[1]),
        tip: (match) => `Did you declare <code>${escapeHTML(match[1])}</code>? Check for typos or scope issues.`
    },
    {
        pattern: /Unresolved\s+field\s+'(.*?)'\s+in\s+type\s+'(.*?)'/i,
        reason: (match) => `The type <b>${escapeHTML(match[2])}</b> doesn't have a field or property called <code>${escapeHTML(match[1])}</code>.`,
        expected: (match) => `A valid field name defined in the ${escapeHTML(match[2])} struct/contract`,
        received: (match) => escapeHTML(match[1]),
        tip: (match) => `Check the definition of <b>${escapeHTML(match[2])}</b>. Did you mean to use a different field?`
    },
    {
        pattern: /Unexpected\s+token\s+'(.*?)'/i,
        reason: (match) => `The compiler found a <code>${escapeHTML(match[1])}</code> where it didn't expect one.`,
        expected: (match) => `A semicolon, bracket, or valid keyword`,
        received: (match) => escapeHTML(match[1]),
        tip: () => `This is often caused by a missing semicolon (<code>;</code>) on the previous line or an unclosed bracket.`
    }
];

function getSensibleErrorReport(rawOutput) {
    if (!rawOutput) return null;
    const lines = rawOutput.split('\n');
    const errors = [];
    
    for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        // Match: [Error: ]file.tact:line:col: message
        const match = line.match(/(?:Error:\s+)?(.*?\.tact):(\d+):(\d+):\s+(.*)/i);
        
        if (match) {
            const [_, file, lineNum, col, message] = match;
            const error = {
                file, line: lineNum, col, 
                rawMessage: message,
                snippet: []
            };

            // Capture next few lines if they contain the code snippet
            let j = i + 1;
            while (j < lines.length && j < i + 6) {
                const nextLine = lines[j];
                if (nextLine.includes('|') || nextLine.trim().startsWith('^') || nextLine.includes('>')) {
                    error.snippet.push(nextLine);
                    j++;
                } else if (nextLine.trim() === "" && error.snippet.length > 0) {
                    j++;
                } else {
                    break;
                }
            }
            errors.push(error);
        }
    }

    if (errors.length === 0) return null;

    let report = `❌ <b>Code Error</b>\n🛑 <b>Tact Compilation Failed</b> (${errors.length} error${errors.length > 1 ? 's' : ''})\n\n`;

    errors.forEach((err, idx) => {
        let diagnosis = {
            expected: "Valid Tact syntax",
            received: "Unknown",
            reason: escapeHTML(err.rawMessage),
            tip: `Check the syntax around line ${err.line} in ${err.file}.`
        };

        for (const item of ERROR_RUBRIC) {
            const m = err.rawMessage.match(item.pattern);
            if (m) {
                diagnosis.reason = typeof item.reason === 'function' ? item.reason(m) : item.reason;
                diagnosis.expected = typeof item.expected === 'function' ? item.expected(m) : item.expected;
                diagnosis.received = typeof item.received === 'function' ? item.received(m) : item.received;
                diagnosis.tip = typeof item.tip === 'function' ? item.tip(m, err.file, err.line) : item.tip;
                break;
            }
        }

        report += `<b>Error ${idx + 1}:</b> ${escapeHTML(err.rawMessage)}\n`;
        report += `<b>Location:</b> ${escapeHTML(err.file)}:${err.line}:${err.col}\n`;
        report += `🧐 <b>Expected:</b> ${diagnosis.expected}\n`;
        report += `❌ <b>Received:</b> ${diagnosis.received}\n\n`;
        
        if (err.snippet.length > 0) {
            report += `<pre>${escapeHTML(err.snippet.join('\n'))}</pre>\n`;
        }

        report += `💡 <b>Tip:</b> ${diagnosis.tip}\n`;
        if (idx < errors.length - 1) report += `\n───────────────\n\n`;
    });

    return report;
}

module.exports = {
    getSensibleErrorReport,
    ERROR_RUBRIC
};
