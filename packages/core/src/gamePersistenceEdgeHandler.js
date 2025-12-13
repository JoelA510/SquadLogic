import { processGamePersistenceRequest } from './gamePersistenceApi.js';

function responseWithJson(payload, status = 200) {
    return new Response(JSON.stringify(payload), {
        status,
        headers: { 'Content-Type': 'application/json' },
    });
}

function mapStatusToHttpCode(status) {
    switch (status) {
        case 'success':
            return 200;
        case 'blocked':
            return 409;
        case 'unauthorized':
            return 401;
        case 'forbidden':
            return 403;
        default:
            return 400;
    }
}

export function createGamePersistenceHttpHandler({
    supabaseClient,
    allowedRoles,
    now,
    getUser,
} = {}) {
    if (!supabaseClient) {
        throw new TypeError('supabaseClient is required');
    }

    return async function handle(request) {
        try {
            if (!request || typeof request.json !== 'function') {
                return responseWithJson(
                    { status: 'error', message: 'Invalid request object' },
                    400,
                );
            }

            let body;
            try {
                body = await request.json();
            } catch (error) {
                return responseWithJson(
                    { status: 'error', message: 'Invalid JSON payload' },
                    400,
                );
            }

            const user = getUser ? await getUser(request) : undefined;
            const effectiveNow = now ?? new Date();
            const result = await processGamePersistenceRequest({
                supabaseClient,
                requestBody: body,
                user,
                allowedRoles,
                now: effectiveNow,
            });

            return responseWithJson(result, mapStatusToHttpCode(result.status));
        } catch (error) {
            console.error('Unhandled error in game persistence handler:', error);
            return responseWithJson(
                { status: 'error', message: 'An internal server error occurred.' },
                500,
            );
        }
    };
}
