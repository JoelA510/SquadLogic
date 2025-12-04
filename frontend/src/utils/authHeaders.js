export async function buildSupabaseAuthHeaders(supabaseClient) {
    if (!supabaseClient) return {};
    const {
        data: { session },
    } = await supabaseClient.auth.getSession();
    const token = session?.access_token;
    if (!token) return {};
    return { Authorization: `Bearer ${token}` };
}
