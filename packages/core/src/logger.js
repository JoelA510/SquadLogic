/**
 * Simple Logger wrapper to standardize output and facilitate future remote logging integration.
 */
class Logger {
    /**
     * Log an info message
     * @param {string} message 
     * @param {Object} [data] 
     */
    static info(message, data) {
        console.info(`[INFO] ${message}`, data || '');
    }

    /**
     * Log a warning message
     * @param {string} message 
     * @param {Object} [data] 
     */
    static warn(message, data) {
        console.warn(`[WARN] ${message}`, data || '');
    }

    /**
     * Log an error message
     * @param {string} message 
     * @param {Error|Object} [error] 
     */
    static error(message, error) {
        console.error(`[ERROR] ${message}`, error || '');
    }
}

export default Logger;
