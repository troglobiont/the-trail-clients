export function createCloudAPI({ url, key, request }) {
  if (!/^https:\/\/[a-z0-9]+\.supabase\.co$/.test(url) || !/^sb_publishable_[\w-]+$/.test(key)) throw Error('Облако ещё не настроено');

  async function post(path, data, token) {
    const headers = { apikey: key, 'Content-Type': 'application/json' };
    if (token) headers.Authorization = `Bearer ${token}`;
    const response = await request({ url: url + path, method: 'POST', headers, data, connectTimeout: 10000, readTimeout: 20000 });
    if (response.status < 200 || response.status >= 300) {
      let garminError;
      if(path==='/functions/v1/trail-garmin-connect'){
        garminError=response.status===404?'Подключение Garmin Connect пока недоступно':
          response.status===401?'Войди в облако The.Trail для подключения Garmin':
          response.status===403?'Нет доступа к подключению Garmin':'Не удалось подключить Garmin Connect';
      }else if(path==='/functions/v1/trail-garmin'){
        try{
          const data=typeof response.data==='string'?JSON.parse(response.data):response.data;
          if(['Garmin ещё не подключён','Garmin привязан к другой карточке','Не удалось обновить Garmin',
            'Нет доступа к этому Garmin','Войди снова для Garmin'].includes(data?.error))garminError=data.error;
        }catch{}
        garminError??=response.status===404?'Облачная интеграция Garmin ещё не настроена':'Не удалось обновить Garmin';
      }
      const trainingError=path.startsWith('/rest/v1/rpc/trail_training_week_')&&(
        response.status===404?'Облачная публикация тренировок пока недоступна':
        response.status===403?'Нет доступа к облачной неделе':
        response.status===409?'Подготовленная неделя изменилась. Открой её ещё раз.':'Не удалось обратиться к облачной неделе');
      const message = garminError||trainingError||(path.startsWith('/functions/') ? 'Не удалось обновить облачное расписание' :
        path.startsWith('/auth/') ? 'Не удалось войти. Проверь почту и пароль' :
        response.status === 403 ? 'Этот аккаунт ещё не подключён к базе The.Trail' : 'Облако не приняло изменения');
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
    read(revision, token) { return post('/rest/v1/rpc/trail_sync_read_v2', { p_revision: revision < 0 ? null : revision }, token); },
    calendar(range, token) { return post('/functions/v1/trail-calendar',range,token); },
    groupWeek(day, token) { return post('/rest/v1/rpc/trail_group_week_read',{p_day:day},token); },
    garmin(clientId, token) { return post('/functions/v1/trail-garmin',{clientId},token); },
    garminConnection(clientId, action, token) { return post('/functions/v1/trail-garmin-connect',{clientId,action},token); },
    trainingWeek(clientId, prepared, token, weekStart) {
      return post('/rest/v1/rpc/trail_training_week_read',{
        p_client_id:clientId,p_prepared:prepared,...(weekStart&&{p_week_start:weekStart})
      },token);
    },
    publishTrainingWeek(clientId, week, token) {
      return post('/rest/v1/rpc/trail_training_week_publish',{
        p_client_id:clientId,p_week_start:week.weekStart,p_checked_at:week.checkedAt
      },token);
    },
    write(flight, token) { return post('/rest/v1/rpc/trail_sync_write_v2', { p_revision: flight.revision, p_request: flight.id, p_changes: flight.changes }, token); }
  };
}
