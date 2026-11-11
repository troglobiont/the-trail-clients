import { acknowledgeCloudWrite, beginCloudSync, prepareCloudWrite, receiveCloudData } from './cloud-state.js';

const editCloud = { trackCloud: false };

export function createCloudSync({ store, api, vault, onChange = () => {}, onReceive = () => {} }) {
  let session = null, running = null, timer = null, view = { status: 'disconnected', conflicts: [], revision: null };
  const emit = (status, fields = {}) => {
    view = { status, conflicts: [], revision: null, email: session?.email || '', ...fields };
    onChange(view);
  };
  const meta = () => store.state().cloudSync;

  async function saveSession(next) {
    await vault.save(JSON.stringify(next));
    session = next;
  }

  async function request(call) {
    if (!session) throw Error('Войди для синхронизации');
    const refresh = async () => {
      try {
        const next = await api.refresh(session.refresh);
        if (next.owner !== meta().owner) throw Error('Аккаунт облака изменился');
        await saveSession(next);
      } catch (error) {
        if ([400,401,403].includes(error.status)) {
          session = null;
          await vault.save('');
          throw Error('Войди снова для синхронизации');
        }
        throw error;
      }
    };
    if (session.expires < Date.now() + 60000) await refresh();
    try { return await call(session.access); }
    catch (error) {
      if (error.status !== 401) throw error;
      await refresh();
      return call(session.access);
    }
  }

  async function exchange(decision) {
    emit('working');
    for (let count = 0; count < 6; count++) {
      const flight = meta().flight;
      if (flight) {
        const response = await request(token => api.write(flight, token));
        await store.mutate(state => acknowledgeCloudWrite(state, flight, response), editCloud);
      }
      const remote = await request(token => api.read(meta().revision, token));
      const choices = remote.revision === decision?.revision ? decision.choices : {};
      const conflicts = remote.data === null && remote.revision === meta().revision ? []
        : await store.mutate(state => receiveCloudData(state, remote, choices), editCloud);
      if (conflicts.length) {
        emit('conflict', { conflicts, revision: remote.revision });
        return;
      }
      if (remote.data !== null) onReceive();
      if (!Object.keys(meta().pending).length) {
        emit('synced');
        return;
      }
      await store.mutate(prepareCloudWrite, editCloud);
    }
    emit('pending');
  }

  function sync(decision) {
    clearTimeout(timer);
    if (running) return running;
    if (!session || !meta()) return Promise.resolve();
    if (view.status === 'conflict' && !decision) return Promise.resolve();
    running = exchange(decision).catch(error => emit(session ? 'error' : 'disconnected', {
      error: error.message || 'Облако недоступно'
    })).finally(() => {
      running = null;
      if (view.status === 'synced' && Object.keys(meta().pending).length) {
        emit('pending');
        timer = setTimeout(() => sync(), 750);
      }
    });
    return running;
  }

  store.subscribe(state => {
    if (!session || !state.cloudSync || running || view.status === 'conflict' || !Object.keys(state.cloudSync.pending).length) return;
    if (view.status !== 'pending') emit('pending');
    clearTimeout(timer);
    timer = setTimeout(() => sync(), 750);
  });

  return {
    state: () => view,
    sync,
    async restore() {
      const value = await vault.load();
      if (!value || !meta()) return;
      const saved = JSON.parse(value);
      if (saved.owner !== meta().owner) return;
      session = saved;
      await sync();
    },
    async connect(email, password) {
      const next = await api.signIn(email, password);
      if (meta() && next.owner !== meta().owner) throw Error('Войди под аккаунтом, к которому привязана база телефона');
      await api.read(-1, next.access);
      await store.mutate(state => beginCloudSync(state, next.owner), editCloud);
      await saveSession(next);
      await sync();
    },
    async disconnect() {
      if (running) await running;
      clearTimeout(timer);
      await vault.save('');
      session = null;
      emit('disconnected');
    }
  };
}
