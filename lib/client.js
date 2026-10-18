window.__ModuleLoader__.load({
  id: 'dsh-workbuddy-switcher',
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' });

    const react = require('react');
    const jsxRuntime = require('react/jsx-runtime');
    const { jsx, jsxs } = jsxRuntime;

    const ROUTE = '/plugins/dsh-workbuddy-switcher/accounts';

    /**
     * Re-read the Host model catalog in this tab.
     *
     * `resetGeneration()` is deliberate rather than `refresh()`: it clears the
     * catalog value first, which makes every selector drop its current
     * selection for one render. That unmounts the composer's WorkBuddy probe
     * control and — because its React key is `provider:model` — remounts it
     * afterwards, and its mount effect is the *only* thing that re-reads the
     * account's credit balance. A plain `refresh()` keeps the same model id,
     * so the component never remounts and the badge would keep showing the
     * previous account's balance after a switch.
     *
     * Assigned by {@link apply} once the `modelDirectories` service exists;
     * stays a no-op when this Host generation does not expose it.
     */
    let refreshHostModelCatalog = () => {};

    /**
     * Ask the Host to rebuild the model catalog behind every selector.
     *
     * @returns whether a refresh was actually requested.
     */
    function refreshModelPicker() {
      try {
        refreshHostModelCatalog();
        return true;
      } catch {
        return false;
      }
    }

    const zh = {
      title: 'WorkBuddy 账号切换',
      intro:
        '从账号库中选择一个账号，插件会把它设为 WorkBuddy 的凭据来源，并立刻刷新模型列表 —— 不用重启 DSH，也不用打开 WorkBuddy 客户端。',
      dir: '账号库',
      current: '当前使用',
      following: '未指定，跟随 WorkBuddy 客户端',
      none: '账号库里还没有账号。先在本机登录一次 WorkBuddy，然后点「导入当前账号」。',
      import: '导入当前账号',
      importing: '导入中…',
      use: '切换到此账号',
      using: '使用中',
      follow: '恢复跟随客户端',
      remove: '删除',
      removeConfirm: '确认删除',
      refresh: '刷新模型',
      loading: '读取中…',
      uid: '账号',
      total: '共',
      clientNew: '客户端已登录新账号，尚未导入：',
      cooldown: '冷却至',
      cooldownModel: '限流模型',
      cooldownAccount: '账号额度',
      cooldownModelHint: '只有这个模型被限流，其他模型仍可用这个账号',
      autoRotate: '额度用尽时自动切号',
      autoRotateHint: '命中 429 / 402 时自动换下一个账号并重试当前请求',
      clearCooldown: '解除冷却',
      clearModelCooldown: '解除该模型冷却',
      expires: '令牌到期',
      refreshExpires: '刷新令牌到期',
      regionCn: '国内版',
      regionGlobal: '国际版',
      fail: '操作失败',
      applied: (state) => `已切换，模型已刷新${state}`,
      refreshed: (state) => `模型列表已刷新${state}`,
      imported: '已导入新账号。',
      cleared: (state) => `已恢复跟随客户端，模型已刷新${state}`,
      deleted: '已删除。',
      expired: '已过期',
      fabLabel: '切换 WorkBuddy 账号',
      fabShort: 'WB',
      close: '关闭',
      noActive: '跟随客户端',
      refreshOk: '（成功）',
      refreshSkipped: '（插件未就绪，稍后会自动更新）',
      exportBundle: '导出凭证',
      importBundle: '导入凭证',
      exporting: '导出中…',
      importing: '导入中…',
      exportWarning:
        '导出的文件是明文令牌，等于这些账号的登录凭据。请只放进你自己的加密存储，用完删除。',
      exported: (n) => `已导出 ${n} 个账号。文件里是明文令牌，请妥善保管。`,
      exportEmpty: '账号库里没有可导出的账号。',
      importSummary: (added, refreshed, kept) =>
        `导入完成：新增 ${added}，更新 ${refreshed}，保留本地 ${kept}。`,
      importBadFile: '这个文件不是本插件导出的凭证包。',
      importReadFail: '读取文件失败',
    };

    const styles = {
      root: {
        display: 'flex',
        flexDirection: 'column',
        gap: '10px',
        fontSize: '13px',
        color: 'var(--dsw-alias-label-primary)',
      },
      intro: {
        margin: 0,
        color: 'var(--dsw-alias-label-tertiary)',
        fontSize: '12px',
        lineHeight: '18px',
      },
      meta: { display: 'flex', gap: '8px', alignItems: 'center', flexWrap: 'wrap' },
      dir: {
        fontFamily: 'monospace',
        fontSize: '11px',
        color: 'var(--dsw-alias-label-tertiary)',
        wordBreak: 'break-all',
      },
      bar: { display: 'flex', gap: '8px', alignItems: 'center', flexWrap: 'wrap' },
      button: {
        font: 'inherit',
        fontSize: '12px',
        padding: '4px 10px',
        borderRadius: '6px',
        border: '0.5px solid var(--dsw-alias-border-l2)',
        background: 'transparent',
        color: 'var(--dsw-alias-label-primary)',
        cursor: 'pointer',
      },
      buttonPrimary: {
        font: 'inherit',
        fontSize: '12px',
        padding: '4px 10px',
        borderRadius: '6px',
        border: '0.5px solid var(--dsw-alias-border-l2)',
        background: 'var(--dsw-alias-bg-l2)',
        color: 'var(--dsw-alias-label-primary)',
        cursor: 'pointer',
      },
      buttonDanger: {
        font: 'inherit',
        fontSize: '12px',
        padding: '4px 10px',
        borderRadius: '6px',
        border: '0.5px solid var(--dsw-alias-border-l2)',
        background: 'transparent',
        color: 'var(--dsw-alias-label-tertiary)',
        cursor: 'pointer',
      },
      list: { display: 'flex', flexDirection: 'column', gap: '6px' },
      card: {
        display: 'flex',
        flexDirection: 'column',
        gap: '6px',
        padding: '8px 10px',
        borderRadius: '8px',
        border: '0.5px solid var(--dsw-alias-border-l2)',
      },
      cardActive: {
        display: 'flex',
        flexDirection: 'column',
        gap: '6px',
        padding: '8px 10px',
        borderRadius: '8px',
        border: '1px solid var(--dsw-alias-label-accent, var(--dsw-alias-border-l2))',
        background: 'var(--dsw-alias-bg-l2)',
      },
      row: { display: 'flex', gap: '10px', alignItems: 'baseline', flexWrap: 'wrap' },
      name: { fontWeight: 600 },
      tag: {
        fontSize: '11px',
        padding: '1px 6px',
        borderRadius: '4px',
        border: '0.5px solid var(--dsw-alias-border-l2)',
        color: 'var(--dsw-alias-label-tertiary)',
      },
      tagCooling: {
        color: 'var(--dsw-alias-label-secondary)',
        fontVariantNumeric: 'tabular-nums',
      },
      checkbox: { display: 'flex', alignItems: 'center', gap: '6px', fontSize: '12px' },
      note: { fontSize: '11px', color: 'var(--dsw-alias-label-tertiary)' },
      banner: {
        display: 'flex',
        alignItems: 'center',
        gap: '8px',
        flexWrap: 'wrap',
        padding: '7px 10px',
        borderRadius: '8px',
        border: '0.5px solid var(--dsw-alias-border-l2)',
        background: 'var(--dsw-alias-bg-l2)',
        fontSize: '12px',
      },
      error: { fontSize: '12px', color: 'var(--dsw-alias-label-danger, inherit)' },
      ok: { fontSize: '12px', color: 'var(--dsw-alias-label-tertiary)' },
      mono: { fontFamily: 'monospace', fontSize: '11px' },
      panel: {
        display: 'flex',
        flexDirection: 'column',
        gap: 10,
        padding: '13px 15px',
        border: '1px solid var(--dsw-alias-border-l2)',
        borderRadius: 12,
        background: 'var(--dsw-alias-bg-module-platform)',
        color: 'var(--dsw-alias-label-primary)',
      },
      overlay: {
        position: 'fixed',
        bottom: 16,
        right: 20,
        zIndex: 30,
        width: 'min(420px, calc(100vw - 40px))',
        pointerEvents: 'auto',
        maxHeight: 'calc(100vh - 120px)',
        overflowY: 'auto',
        boxSizing: 'border-box',
        boxShadow: '0 8px 28px rgba(0, 0, 0, 0.16)',
      },
      fab: {
        position: 'fixed',
        bottom: 16,
        right: 20,
        zIndex: 30,
        display: 'flex',
        alignItems: 'center',
        gap: 6,
        padding: '7px 12px',
        borderRadius: 999,
        border: '1px solid var(--dsw-alias-border-l2)',
        background: 'var(--dsw-alias-bg-module-platform)',
        color: 'var(--dsw-alias-label-primary)',
        font: 'inherit',
        fontSize: 12,
        cursor: 'pointer',
        pointerEvents: 'auto',
        boxShadow: '0 4px 16px rgba(0, 0, 0, 0.14)',
      },
      fabDot: {
        width: 7,
        height: 7,
        borderRadius: '50%',
        background: 'var(--dsw-alias-label-accent, #4c8dff)',
        flex: '0 0 auto',
      },
    };

    /**
     * Ask `dsh-workbuddy-connect` to re-read its credential and re-fetch the
     * model catalog right now, instead of waiting for its 30-second sweep.
     *
     * The plugin's control route is write-gated by a per-process probe key, so
     * this reads the status document first (same origin) and replays that key
     * on the refresh call. Both variants are nudged; a signed-out one answers
     * `signed-out` and costs nothing.
     *
     * Running this from the browser is deliberate: it needs only a page
     * reload to take effect, not a DSH restart.
     *
     * @returns the per-variant outcomes, or `undefined` when the plugin is absent.
     */
    async function nudgeWorkBuddy() {
      const outcomes = [];
      for (const suffix of ['', '/ai']) {
        const base = `/plugins/dsh-workbuddy-connect${suffix}`;
        try {
          const statusResponse = await fetch(`${base}/status`, {
            credentials: 'same-origin',
            cache: 'no-store',
            headers: { accept: 'application/json' },
          });
          if (!statusResponse.ok) {
            outcomes.push({ variant: suffix === '' ? 'cn' : 'ai', state: `status-http-${statusResponse.status}` });
            continue;
          }
          const status = await statusResponse.json().catch(() => undefined);
          const key = status?.probeKey;
          if (typeof key !== 'string' || key === '') {
            outcomes.push({ variant: suffix === '' ? 'cn' : 'ai', state: 'no-probe-key' });
            continue;
          }
          const probeResponse = await fetch(`${base}/probe`, {
            method: 'POST',
            credentials: 'same-origin',
            headers: { 'Content-Type': 'application/json', 'X-WorkBuddy-Probe-Key': key },
            body: JSON.stringify({ action: 'refresh' }),
          });
          const body = await probeResponse.json().catch(() => undefined);
          outcomes.push({
            variant: suffix === '' ? 'cn' : 'ai',
            state: probeResponse.ok ? (body?.state ?? 'ok') : `probe-http-${probeResponse.status}`,
            ...(typeof body?.reason === 'string' ? { reason: body.reason } : {}),
          });
        } catch (failure) {
          outcomes.push({
            variant: suffix === '' ? 'cn' : 'ai',
            state: 'error',
            reason: failure instanceof Error ? failure.message : String(failure),
          });
        }
      }
      return outcomes;
    }

    /**
     * Summarize a nudge outcome for the status line.
     *
     * @param outcomes - per-variant results, or `undefined` when not attempted.
     * @returns a short suffix, empty when a variant actually refreshed.
     */
    function refreshStateOf(outcomes) {
      if (!Array.isArray(outcomes)) return zh.refreshSkipped;
      if (outcomes.some((outcome) => outcome.state === 'refreshed')) return '';
      const failures = outcomes.filter((outcome) => outcome.state !== 'signed-out');
      return failures.length === 0 ? '' : zh.refreshSkipped;
    }

    function fmtDate(ms) {
      if (typeof ms !== 'number' || ms <= 0) return '—';
      const date = new Date(ms);
      const text = date.toLocaleString(undefined, {
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
      });
      return date.getTime() <= Date.now() ? `${text} (${zh.expired})` : text;
    }

    /** Short clock for a cooldown badge: `MM-DD HH:mm`, with a date-less form for today. */
    function fmtClock(ms) {
      if (typeof ms !== 'number' || ms <= 0) return '—';
      const date = new Date(ms);
      const sameDay = date.toDateString() === new Date().toDateString();
      return date.toLocaleString(undefined, {
        ...(sameDay ? {} : { month: '2-digit', day: '2-digit' }),
        hour: '2-digit',
        minute: '2-digit',
      });
    }

    function shortUid(uid) {
      return typeof uid === 'string' && uid.length > 13 ? `${uid.slice(0, 8)}…${uid.slice(-4)}` : uid || '—';
    }

    function labelOf(account) {
      return account.nickname || shortUid(account.uid);
    }

    /** Shared data layer: loads the account list and exposes the actions. */
    function useAccounts() {
      const [state, setState] = react.useState(undefined);
      const [error, setError] = react.useState(undefined);
      const [busy, setBusy] = react.useState(undefined);
      const [ok, setOk] = react.useState(undefined);
      const mounted = react.useRef(false);
      /** Latest archived file list, kept in a ref so the poller reads it without re-subscribing. */
      const known = react.useRef('');

      const load = react.useCallback(async (signal) => {
        try {
          const response = await fetch(ROUTE, {
            credentials: 'same-origin',
            cache: 'no-store',
            headers: { accept: 'application/json' },
            ...(signal === undefined ? {} : { signal }),
          });
          if (!response.ok) throw new Error(`HTTP ${response.status}`);
          const value = await response.json();
          if (!mounted.current || (signal !== undefined && signal.aborted)) return;
          setState(value);
          setError(undefined);
          return value;
        } catch (failure) {
          if (failure?.name === 'AbortError') return undefined;
          if (!mounted.current) return undefined;
          setError(failure instanceof Error ? failure.message : String(failure));
          return undefined;
        }
      }, []);

      react.useEffect(() => {
        mounted.current = true;
        const controller = new AbortController();
        load(controller.signal);
        return () => {
          mounted.current = false;
          controller.abort();
        };
      }, [load]);

      // Poll the archive directory while the panel is open, so an account signed
      // in through the desktop app appears without the user pressing anything.
      // A refresh only replaces the list when the file set actually changed:
      // re-setting an identical list would re-render every row every few
      // seconds for no reason.
      react.useEffect(() => {
        const timer = window.setInterval(() => {
          void (async () => {
            const next = await load();
            if (next === undefined || !mounted.current) return;
            const signature = (next.accounts ?? []).map((account) => account.file).join('|');
            if (signature !== known.current) known.current = signature;
          })();
        }, 10000);
        return () => window.clearInterval(timer);
      }, [load]);

      const run = react.useCallback(
        async (label, body) => {
          setBusy(label);
          setOk(undefined);
          setError(undefined);
          try {
            const response = await fetch(ROUTE, {
              method: 'POST',
              credentials: 'same-origin',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify(body),
            });
            const value = await response.json().catch(() => undefined);
            if (!response.ok) throw new Error(value?.error ?? `HTTP ${response.status}`);
            if (!mounted.current) return;
            // The current host nudge runs on the host; an older host does not,
            // so the browser performs the same call itself. Exactly one of the
            // two runs, so the plugin's catalog endpoint is hit once.
            const outcomes =
              value?.refresh === undefined ? await nudgeWorkBuddy() : value.refresh.outcomes;
            refreshModelPicker();
            if (!mounted.current) return;
            const refreshState = refreshStateOf(outcomes);
            setOk(
              body.action === 'select'
                ? zh.applied(refreshState)
                : body.action === 'import'
                  ? zh.imported
                  : body.action === 'delete'
                    ? zh.deleted
                    : body.action === 'refresh'
                      ? zh.refreshed(refreshState)
                      : zh.cleared(refreshState),
            );
            await load();
          } catch (failure) {
            if (!mounted.current) return;
            setError(failure instanceof Error ? failure.message : String(failure));
          } finally {
            if (mounted.current) setBusy(undefined);
          }
        },
        [load],
      );

      /**
       * Refresh the WorkBuddy model catalog without changing the selection.
       *
       * This talks to `dsh-workbuddy-connect` directly rather than posting
       * `refresh` to our own route, so it works even against a host running an
       * older build of this plugin that has no such action.
       */
      const refreshModels = react.useCallback(async () => {
        setBusy('refresh');
        setOk(undefined);
        setError(undefined);
        try {
          const outcomes = await nudgeWorkBuddy();
          refreshModelPicker();
          if (!mounted.current) return;
          setOk(zh.refreshed(refreshStateOf(outcomes)));
          await load();
        } catch (failure) {
          if (!mounted.current) return;
          setError(failure instanceof Error ? failure.message : String(failure));
        } finally {
          if (mounted.current) setBusy(undefined);
        }
      }, [load]);

      /**
       * Download every archive as one bundle file.
       *
       * Plaintext by design (the user chose that), so it takes two clicks: the
       * first replaces the button with an explicit warning, the second writes
       * the file. That is the whole safeguard — the credentials are otherwise
       * indistinguishable from any other JSON on disk.
       */
      const exportBundle = react.useCallback(async () => {
        setBusy('export');
        setOk(undefined);
        setError(undefined);
        try {
          const response = await fetch(ROUTE, {
            method: 'POST',
            credentials: 'same-origin',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ action: 'export' }),
          });
          const value = await response.json().catch(() => undefined);
          if (!response.ok) throw new Error(value?.error ?? `HTTP ${response.status}`);
          const accounts = Array.isArray(value?.accounts) ? value.accounts : [];
          if (accounts.length === 0) {
            if (mounted.current) setOk(zh.exportEmpty);
            return;
          }
          const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
          const blob = new Blob([`${JSON.stringify(value, null, 2)}\n`], {
            type: 'application/json',
          });
          const url = URL.createObjectURL(blob);
          const anchor = document.createElement('a');
          anchor.href = url;
          anchor.download = `workbuddy-accounts-${stamp}.json`;
          document.body.appendChild(anchor);
          anchor.click();
          anchor.remove();
          // Revoke on the next task so the download has started.
          window.setTimeout(() => URL.revokeObjectURL(url), 10_000);
          if (mounted.current) setOk(zh.exported(accounts.length));
        } catch (failure) {
          if (!mounted.current) return;
          setError(failure instanceof Error ? failure.message : String(failure));
        } finally {
          if (mounted.current) setBusy(undefined);
        }
      }, []);

      /**
       * Merge a previously exported bundle into this machine's archive.
       *
       * The file is read and parsed in the browser, then posted as JSON — the
       * host never learns a path, and the user picks the file through the
       * normal picker instead of typing one.
       */
      const importBundleFile = react.useCallback(
        async (file) => {
          setBusy('import-bundle');
          setOk(undefined);
          setError(undefined);
          try {
            const text = typeof file.text === 'function'
              ? await file.text()
              : await new Promise((resolve, reject) => {
                  const reader = new FileReader();
                  reader.onload = () => resolve(String(reader.result ?? ''));
                  reader.onerror = () => reject(reader.error ?? new Error(zh.importReadFail));
                  reader.readAsText(file);
                });
            let bundle;
            try {
              bundle = JSON.parse(text);
            } catch {
              throw new Error(zh.importBadFile);
            }
            const response = await fetch(ROUTE, {
              method: 'POST',
              credentials: 'same-origin',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ action: 'import-bundle', bundle }),
            });
            const value = await response.json().catch(() => undefined);
            if (!response.ok) throw new Error(value?.error ?? `HTTP ${response.status}`);
            if (!mounted.current) return;
            setOk(
              zh.importSummary(
                (value?.added ?? []).length,
                (value?.refreshed ?? []).length,
                (value?.kept ?? []).length,
              ),
            );
            await load();
          } catch (failure) {
            if (!mounted.current) return;
            setError(failure instanceof Error ? failure.message : String(failure));
          } finally {
            if (mounted.current) setBusy(undefined);
          }
        },
        [load],
      );

      return {
        state,
        error,
        busy,
        ok,
        run,
        load,
        refreshModels,
        exportBundle,
        importBundleFile,
        setOk,
      };
    }

    /**
     * Short model name for a cooldown badge.
     *
     * Upstream model ids carry a vendor prefix and a long suffix; the tail is
     * what distinguishes them ("claude-sonnet-4-5" vs "claude-opus-4-1"), so the
     * badge keeps the tail and drops the rest.
     *
     * @param model - upstream model id.
     * @returns a label short enough for a tag.
     */
    function shortModel(model) {
      if (typeof model !== 'string' || model === '') return '—';
      return model.length > 28 ? `…${model.slice(-27)}` : model;
    }

    /** The account list body shared by the settings card and the floating panel. */
    function AccountList({ view, compact }) {
      const { state, busy, run } = view;
      const [confirming, setConfirming] = react.useState(undefined);
      const accounts = state?.accounts ?? [];
      const selectedFile = state?.selectedFile ?? null;

      if (accounts.length === 0) {
        return jsx('p', { style: styles.note, children: zh.none });
      }
      return jsxs('div', {
        style: styles.list,
        children: accounts.map((account) => {
          // One badge per live cooldown scope: `model: null` is the whole
          // account, anything else is that model only. Rendering them
          // separately is the point — a login limited on one model must not look
          // like an exhausted login.
          const scopes = Array.isArray(account.cooldowns) ? account.cooldowns : [];
          return jsxs(
            'div',
            {
              style: account.file === selectedFile ? styles.cardActive : styles.card,
              children: [
                jsxs('div', {
                  style: styles.row,
                  children: [
                    jsx('span', { style: styles.name, children: labelOf(account) }),
                    jsx('span', {
                      style: styles.tag,
                      children: account.region === 'global' ? zh.regionGlobal : zh.regionCn,
                    }),
                    account.enterpriseId
                      ? jsx('span', { style: styles.tag, children: 'Enterprise' })
                      : null,
                    account.file === selectedFile
                      ? jsx('span', { style: styles.tag, children: zh.using })
                      : null,
                    scopes.map((scope) =>
                      jsx(
                        'span',
                        {
                          style: {
                            ...styles.tag,
                            ...styles.tagCooling,
                            // A scope that does not block the routed model is
                            // still worth showing, but quietly: the login works
                            // for what the user is about to send.
                            ...(account.blocked === false ? { opacity: 0.65 } : {}),
                          },
                          title: scope.reason ?? undefined,
                          children:
                            scope.model === null
                              ? `${zh.cooldownAccount} ${fmtClock(scope.untilMs)}`
                              : `${shortModel(scope.model)} ${zh.cooldown} ${fmtClock(scope.untilMs)}`,
                        },
                        `${account.file}:${scope.model ?? '*'}@${scope.untilMs}`,
                      ),
                    ),
                  ],
                }),
                compact
                  ? null
                  : jsxs('div', {
                      style: styles.row,
                      children: [
                        jsx('span', { style: styles.mono, children: account.uid || '—' }),
                        jsx('span', {
                          style: styles.note,
                          children: `${zh.refreshExpires}: ${fmtDate(account.refreshExpiresAtMs)}`,
                        }),
                      ],
                    }),
                jsxs('div', {
                  style: styles.bar,
                  children: [
                    account.file === selectedFile
                      ? null
                      : jsx('button', {
                          type: 'button',
                          style: styles.buttonPrimary,
                          disabled: busy !== undefined,
                          onClick: () =>
                            run(`select:${account.file}`, { action: 'select', file: account.file }),
                          children: busy === `select:${account.file}` ? zh.loading : zh.use,
                        }),
                    jsx('button', {
                      type: 'button',
                      style: styles.buttonDanger,
                      disabled: busy !== undefined,
                      onClick: () => {
                        if (confirming === account.file) {
                          setConfirming(undefined);
                          run(`delete:${account.file}`, { action: 'delete', file: account.file });
                        } else {
                          setConfirming(account.file);
                        }
                      },
                      children:
                        confirming === account.file
                          ? zh.removeConfirm
                          : busy === `delete:${account.file}`
                            ? zh.loading
                            : zh.remove,
                    }),
                    // A model-scoped limit gets a per-model clear, so the user
                    // can retry just the model that was throttled without
                    // reopening the whole account — and a whole-account limit
                    // keeps the plain "clear cooldown" wording.
                    ...scopes.map((scope) =>
                      jsx('button', {
                        type: 'button',
                        style: styles.button,
                        title: scope.model === null ? (scope.reason ?? undefined) : zh.cooldownModelHint,
                        disabled: busy !== undefined,
                        onClick: () =>
                          run(`clear-cooldown:${account.file}:${scope.model ?? ''}`, {
                            action: 'clear-cooldown',
                            file: account.file,
                            ...(scope.model === null ? {} : { model: scope.model }),
                          }),
                        children: scope.model === null ? zh.clearCooldown : zh.clearModelCooldown,
                      }, `clear:${account.file}:${scope.model ?? '*'}`),
                    ),
                  ],
                }),
              ],
            },
            account.file,
          );
        }),
      });
    }

    /** Status line + action buttons shared by both surfaces. */
    function Footer({ view }) {
      const { state, busy, run, error, ok, refreshModels, exportBundle, importBundleFile } = view;
      const selectedFile = state?.selectedFile ?? null;
      const accounts = state?.accounts ?? [];
      const selected = accounts.find((account) => account.file === selectedFile);

      // Export writes a plaintext bundle in one click. The warning travels with
      // the file (its `warning` field) and in the button's tooltip, rather than
      // blocking the click — a confirmation step here only added friction.
      const fileInput = react.useRef(null);

      // The desktop app can sign in to an account that has no archive yet. Say so
      // instead of leaving the user to wonder why their new account is missing.
      const clientUid = state?.clientAccount?.uid;
      const archived = clientUid === undefined || clientUid === ''
        ? undefined
        : accounts.find((account) => account.uid === clientUid);

      const exportButton = jsx('button', {
        type: 'button',
        style: styles.button,
        disabled: busy !== undefined || accounts.length === 0,
        title: zh.exportWarning,
        onClick: () => void exportBundle(),
        children: busy === 'export' ? zh.exporting : zh.exportBundle,
      });

      return jsxs('div', {
        style: { display: 'flex', flexDirection: 'column', gap: 8 },
        children: [
          jsxs('div', {
            style: styles.row,
            children: [
              jsx('span', { style: styles.note, children: `${zh.current}: ` }),
              jsx('span', {
                style: styles.name,
                children: selected === undefined ? zh.following : labelOf(selected),
              }),
              jsx('span', { style: styles.note, children: `${zh.total}: ${accounts.length}` }),
              typeof state?.activeModel === 'string' && state.activeModel !== ''
                ? jsx('span', {
                    style: styles.tag,
                    title: zh.cooldownModelHint,
                    children: `${zh.cooldownModel}: ${shortModel(state.activeModel)}`,
                  })
                : null,
            ],
          }),
          clientUid === undefined || clientUid === '' || archived !== undefined
            ? null
            : jsxs('div', {
                style: styles.banner,
                children: [
                  jsx('span', {
                    children: `${zh.clientNew} ${shortUid(clientUid)}`,
                  }),
                  jsx('button', {
                    type: 'button',
                    style: styles.button,
                    disabled: busy !== undefined,
                    onClick: () => run('import', { action: 'import' }),
                    children: busy === 'import' ? zh.importing : zh.import,
                  }),
                ],
              }),
          jsxs('div', {
            style: styles.bar,
            children: [
              jsx('button', {
                type: 'button',
                style: styles.button,
                disabled: busy !== undefined,
                onClick: () => run('import', { action: 'import' }),
                children: busy === 'import' ? zh.importing : zh.import,
              }),
              selectedFile === null
                ? null
                : jsx('button', {
                    type: 'button',
                    style: styles.button,
                    disabled: busy !== undefined,
                    onClick: () => run('clear', { action: 'clear' }),
                    children: zh.follow,
                  }),
              jsx('button', {
                type: 'button',
                style: styles.button,
                disabled: busy !== undefined,
                onClick: () => refreshModels(),
                children: busy === 'refresh' ? zh.loading : zh.refresh,
              }),
              exportButton,
              jsx('button', {
                type: 'button',
                style: styles.button,
                disabled: busy !== undefined,
                onClick: () => fileInput.current?.click(),
                children: busy === 'import-bundle' ? zh.importing : zh.importBundle,
              }),
              jsx('input', {
                ref: fileInput,
                type: 'file',
                accept: 'application/json,.json',
                style: { display: 'none' },
                onChange: (event) => {
                  const file = event.target.files?.[0];
                  // Reset first so picking the same file twice still fires.
                  event.target.value = '';
                  if (file !== undefined) void importBundleFile(file);
                },
              }),
            ],
          }),
          jsxs('label', {
            style: styles.checkbox,
            title: zh.autoRotateHint,
            children: [
              jsx('input', {
                type: 'checkbox',
                checked: state?.autoRotate !== false,
                disabled: busy !== undefined,
                onChange: (event) =>
                  run('auto-rotate', {
                    action: 'set-auto-rotate',
                    enabled: event.target.checked === true,
                  }),
              }),
              jsxs('span', {
                children: [
                  zh.autoRotate,
                  jsx('span', { style: styles.note, children: ` — ${zh.autoRotateHint}` }),
                ],
              }),
            ],
          }),
          error === undefined ? null : jsx('p', { style: styles.error, children: `${zh.fail}: ${error}` }),
          ok === undefined ? null : jsx('p', { style: styles.ok, children: ok }),
        ],
      });
    }

    /** The settings page card (Plugins → dsh-workbuddy-switcher → view). */
    function SwitcherPanel() {
      const view = useAccounts();
      const { state } = view;
      return jsxs('div', {
        style: styles.root,
        children: [
          jsx('p', { style: styles.intro, children: zh.intro }),
          jsxs('div', {
            style: styles.meta,
            children: [
              jsx('span', { style: styles.note, children: zh.dir }),
              jsx('span', { style: styles.dir, children: state?.dir ?? '—' }),
            ],
          }),
          jsx(Footer, { view }),
          jsx(AccountList, { view, compact: false }),
        ],
      });
    }

    /** The floating bottom-right launcher plus its popover. */
    function SwitcherFab() {
      const view = useAccounts();
      const [open, setOpen] = react.useState(false);
      const { state } = view;
      const selectedFile = state?.selectedFile ?? null;
      const selected = (state?.accounts ?? []).find((account) => account.file === selectedFile);

      const badge = selected === undefined ? zh.noActive : labelOf(selected);

      return jsxs(react.Fragment, {
        children: [
          jsx('button', {
            type: 'button',
            style: styles.fab,
            title: zh.fabLabel,
            'aria-label': zh.fabLabel,
            'aria-expanded': open,
            onClick: () => setOpen((previous) => !previous),
            children: [
              jsx('span', { style: styles.fabDot }),
              jsx('span', { children: `WorkBuddy · ${badge}` }),
            ],
          }),
          open
            ? jsx('div', {
                style: { ...styles.panel, ...styles.overlay, bottom: 60 },
                role: 'dialog',
                'aria-label': zh.fabLabel,
                children: jsxs('div', {
                  style: { display: 'flex', flexDirection: 'column', gap: 10 },
                  children: [
                    jsxs('div', {
                      style: {
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'space-between',
                        gap: 10,
                      },
                      children: [
                        jsx('strong', { children: zh.title }),
                        jsx('button', {
                          type: 'button',
                          style: styles.button,
                          onClick: () => setOpen(false),
                          children: zh.close,
                        }),
                      ],
                    }),
                    jsx(Footer, { view }),
                    jsx(AccountList, { view, compact: true }),
                  ],
                }),
              })
            : null,
        ],
      });
    }

    function apply(ctx) {
      // The settings-page card.
      ctx.slots.inject('plugins.bundle.config', () =>
        ctx.slots.register(
          { name: 'plugins.bundle.config', key: 'dsh-workbuddy-switcher' },
          SwitcherPanel,
        ),
      );
      // The always-available bottom-right launcher.
      ctx.slots.inject('shell.overlay', () =>
        ctx.slots.register(
          { name: 'shell.overlay', id: 'workbuddy-switcher-fab', order: 35 },
          SwitcherFab,
        ),
      );
      // Keep a handle on the Host-generation model catalog so a switch can
      // force every selector to rebuild — which also remounts the composer's
      // WorkBuddy control, and that remount is what re-reads the credit
      // balance for the account that was just selected.
      ctx.inject(['modelDirectories'], (scope) => {
        const catalog = scope.modelDirectories?.catalog;
        if (catalog === undefined) return;
        if (typeof catalog.resetGeneration === 'function') {
          refreshHostModelCatalog = () => catalog.resetGeneration();
          return;
        }
        if (typeof catalog.refresh === 'function') {
          refreshHostModelCatalog = () => catalog.refresh();
        }
      });
    }

    const name = 'dsh-workbuddy-switcher-client';
    const inject = ['slots'];

    exports.name = name;
    exports.inject = inject;
    exports.apply = apply;
    return module.exports;
  },
});
