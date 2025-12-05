/**
 * Standardized API client for interacting with the backend (Supabase Edge Functions).
 * Automatically handles authorization headers and error resolution.
 */
export class ApiClient {
    constructor(baseUrl, accessToken = null, fetchImpl = undefined) {
        this.baseUrl = baseUrl.endsWith('/') ? baseUrl.slice(0, -1) : baseUrl;
        this.accessToken = accessToken;
        this.fetchImpl = fetchImpl || (typeof fetch !== 'undefined' ? fetch : undefined);
    }

    /**
     * Set the auth token for subsequent requests
     * @param {string} token 
     */
    setAccessToken(token) {
        this.accessToken = token;
    }

    /**
     * Generic fetch wrapper
     * @param {string} endpoint - Relative path (e.g., 'team-persistence')
     * @param {Object} options - Fetch options
     */
    async request(endpoint, options = {}) {
        const url = `${this.baseUrl}/${endpoint}`;

        const headers = {
            'Content-Type': 'application/json',
            ...options.headers,
        };

        if (this.accessToken) {
            headers['Authorization'] = `Bearer ${this.accessToken}`;
        }

        try {
            if (!this.fetchImpl) throw new Error('Fetch implementation not available');
            const response = await this.fetchImpl(url, {
                ...options,
                headers,
            });

            // Attempt to parse JSON regardless of status to get error messages
            let data;
            try {
                data = await response.json();
            } catch (ignore) {
                // Non-JSON response
            }

            if (!response.ok) {
                return {
                    status: 'error',
                    message: data?.message || `Request failed with status ${response.status}`,
                    statusCode: response.status,
                    data
                };
            }

            return data || { status: 'error', message: 'Invalid response: Unable to parse JSON' };
        } catch (error) {
            console.error(`API request to ${endpoint} failed:`, error);
            return {
                status: 'error',
                message: error.message || 'Network request failed',
                error
            };
        }
    }

    /**
     * Helper for POST requests
     */
    async post(endpoint, body, options = {}) {
        return this.request(endpoint, {
            ...options,
            method: 'POST',
            body: JSON.stringify(body),
        });
    }
}
