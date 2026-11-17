function within(promise, milliseconds, error) {
  let timer;
  return Promise.race([promise, new Promise((_, reject) => {
    timer = setTimeout(() => reject(Error(error)), milliseconds);
  })]).finally(() => clearTimeout(timer));
}

function verified(bundle, manifest) {
  return Boolean(bundle?.id && bundle.version === manifest.version
    && ['pending','success'].includes(bundle.status)
    && typeof bundle.checksum === 'string' && bundle.checksum.toLowerCase() === manifest.bundle.sha256);
}

export async function downloadNativeUpdate(plugin, manifest, url, progress, timeout = 90000) {
  const { bundles } = await within(plugin.list(), 5000, 'update-download-timeout');
  const cached = bundles.find(bundle => verified(bundle,manifest));
  if (cached) return cached;

  let completed;
  const downloadComplete = new Promise(resolve => { completed = resolve; });
  let listening = true;
  let percent = 0;
  const subscription = plugin.addListener('download', event => {
    if (!listening || event.bundle?.version !== manifest.version) return;
    if (event.percent === 100 && verified(event.bundle,manifest)) completed(event.bundle);
    percent = Math.max(percent, Math.min(99, Number(event.percent) || 0));
    progress(percent);
  });
  try {
    await within(subscription, 5000, 'update-download-timeout');
    const download = plugin.download({ version:manifest.version,url,checksum:manifest.bundle.sha256 }).then(bundle => {
      if (!verified(bundle,manifest)) throw Error('checksum');
      return bundle;
    });
    return await within(Promise.race([download,downloadComplete]),timeout,'update-download-timeout');
  } finally {
    listening = false;
    // Applying a bundle destroys this page. Listener cleanup must not delay that transition.
    void subscription.then(listener => listener.remove()).catch(() => {});
  }
}

export async function activateNativeUpdate(plugin, bundle, page, { delay = 2500, timeout = 25000 } = {}) {
  page.saveUpdate(bundle.version);
  let timer;
  let active = true;
  try {
    await within(plugin.next({ id:bundle.id }),5000,'update-apply');
    // Normally the native reload destroys this document, including this timer. If it
    // survives, navigate to a new URL only after the new bundle is being served.
    const leavingPage = new Promise((_, reject) => {
      // Resolving the native call without leaving this document is not success.
      void plugin.reload().catch(error => reject(Error('update-apply', { cause:error })));
      const retry = async () => {
        try {
          if (await page.servedVersion() === bundle.version) {
            if (active) page.reloadFresh();
            return;
          }
        } catch { /* The local server can be between bundles. Check again. */ }
        if (active) timer = setTimeout(retry,delay);
      };
      timer = setTimeout(retry,delay);
    });
    await within(leavingPage, timeout, 'update-apply');
  } finally {
    active = false;
    clearTimeout(timer);
  }
}
