/**
 * Convert snake_case string to camelCase.
 * @param {string} str
 * @returns {string}
 */
export function toCamelCase(str) {
    return str.replace(/([-_][a-z])/g, (group) =>
        group.toUpperCase().replace('-', '').replace('_', '')
    );
}

/**
 * Convert camelCase string to snake_case.
 * @param {string} str
 * @returns {string}
 */
export function toSnakeCase(str) {
    return str.replace(/[A-Z]/g, (letter) => `_${letter.toLowerCase()}`);
}

/**
 * Recursively map object keys from snake_case to camelCase.
 * @param {any} obj
 * @returns {any}
 */
export function mapKeysToCamelCase(obj) {
    if (Array.isArray(obj)) {
        return obj.map((v) => mapKeysToCamelCase(v));
    } else if (obj !== null && obj.constructor === Object) {
        return Object.keys(obj).reduce((result, key) => {
            const camelKey = toCamelCase(key);
            result[camelKey] = mapKeysToCamelCase(obj[key]);
            return result;
        }, {});
    }
    return obj;
}
