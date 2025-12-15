/**
 * Custom Error class for Application-specific errors
 */
class AppError extends Error {
    /**
     * @param {string} message 
     * @param {string} [code] - Error code (e.g. 'VALIDATION_ERROR')
     * @param {number} [status] - HTTP status code suggestion (e.g. 400)
     * @param {Object} [meta] - Additional metadata
     */
    constructor(message, code = 'INTERNAL_ERROR', status = 500, meta = {}) {
        super(message);
        this.name = 'AppError';
        this.code = code;
        this.status = status;
        this.meta = meta;
    }
}

export default AppError;
