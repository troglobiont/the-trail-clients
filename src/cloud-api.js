export function createCloudAPI({ url, key, request }) {
  if (!/^https:\/\/[a-z0-9]+\.supabase\.co$/.test(url) || !/^sb_publishable_[\w-]+$/.test(key)) throw Error('Облако ещё не настроено');

  async function post(path, data, token) {
    const headers = { apikey: key, 'Content-Type': 'application/json' };
    if (token) headers.Authorization = `Bearer ${token}`;
    const response = await request({ url: url + path, method: 'POST', headers, data, connectTimeout: 10000, readTimeout: 20000 });
    if (response.status < 200 || response.status >= 300) {
      const message = path.startsWith('/auth/') ? 'Не удалось войти. Проверь почту и пароль' :
        response.status === 403 ? 'Этот аккаунт ещё не подключён к базе The.Trail' : 'Облако не приняло изменения';
      throw Object.assign(Error(message), { status: response.status });
    }
    return typeof response.data === 'string' ? JSON.parse(response.data) : response.data;
  }

  function parseSession(result) {
    if (!result?.access_token || !result?.refresh_token || !result?.user?.id || !Number.isFinite(result.expires_in)) throw Error('Не удалось открыть сеанс');
    return { access: result.access_token, refresh: result.refresh_token, owner: result.user.id,
      email: result.user.email || '', expires: Date.now() + result.expires_in * 1000 };
  }

  return {
    async signIn(email, password) { return parseSession(await post('/auth/v1/token?grant_type=password', { email, password })); },
    async refresh(refreshToken) { return parseSession(await post('/auth/v1/token?grant_type=refresh_token', { refresh_token: refreshToken })); },
    read(revision, token) { return post('/rest/v1/rpc/trail_sync_read', { p_revision: revision < 0 ? null : revision }, token); },
    write(flight, token) { return post('/rest/v1/rpc/trail_sync_write', { p_revision: flight.revision, p_request: flight.id, p_changes: flight.changes }, token); }
  };
}
