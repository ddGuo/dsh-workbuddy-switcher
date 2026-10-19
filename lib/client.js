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

    /** Diameter of the launcher once it is parked against a screen edge. */
    const SNAP_SIZE = 28;

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
      rename: '改名',
      renameSave: '保存',
      renameHint: '给这个账号起一个认得出的名字，只改本地显示，不动凭据',
      renamed: '已保存账号名称。',
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
      checkin: '每日签到',
      checkinHint: '每天自动领取 WorkBuddy 的签到积分；签到季之外自动跳过',
      checkinAll: '全部签到',
      checkinOne: '签到',
      checkinClaimed: (credit, streak) =>
        `已领 +${credit}${typeof streak === 'number' && streak > 0 ? ` · 连签 ${streak} 天` : ''}`,
      checkinAlready: (credit, streak) =>
        `今日已签${typeof credit === 'number' ? ` +${credit}` : ''}${typeof streak === 'number' && streak > 0 ? ` · 连签 ${streak} 天` : ''}`,
      checkinInactive: '签到季未开启',
      checkinRegion: '国际版无签到',
      checkinPending: '待领取',
      checkinFailed: '签到失败',
      checkinResult: {
        claimed: '已领取',
        already: '今日已签',
        inactive: '未开启',
        region: '不适用',
        pending: '待领取',
        auth: '令牌失效',
        network: '网络异常',
        unknown: '异常',
      },
      checkinSummary: (done, total) => `今日签到 ${done}/${total}`,
      checkinOn: '已开启每日自动签到。',
      checkinOff: '已关闭每日自动签到；手动签到仍然可用。',
      checkinBusy: '签到中…',
      checkinDone: (claimed, done, total) =>
        `签到完成：今日 ${done}/${total} 已签${claimed > 0 ? `，本次新领 +${claimed}` : ''}`,
      holdUntil: '手动选定保留至',
      holdHint: '手动切换后 24 小时内不会自动切回更优账号；只有被限流时才会自动换号',
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
      fabExpand: '点击展开 WorkBuddy 账号面板',
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
      list: { display: 'flex', flexDirection: 'column', gap: '8px' },
      card: {
        display: 'flex',
        flexDirection: 'column',
        gap: '6px',
        padding: '9px 11px',
        borderRadius: '10px',
        border: '0.5px solid var(--dsw-alias-border-l2)',
        background: 'var(--dsw-alias-bg-l2)',
      },
      cardActive: {
        display: 'flex',
        flexDirection: 'column',
        gap: '6px',
        padding: '9px 11px',
        borderRadius: '10px',
        border: '1px solid var(--dsw-alias-label-accent, var(--dsw-alias-border-l2))',
        background: 'var(--dsw-alias-bg-l2)',
        boxShadow: 'inset 2px 0 0 var(--dsw-alias-label-accent, transparent)',
      },
      row: { display: 'flex', gap: '8px', alignItems: 'baseline', flexWrap: 'wrap' },
      name: { fontWeight: 600, fontSize: 13 },
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
      tagCheckin: {
        color: 'var(--dsw-alias-label-secondary)',
      },
      tagCheckinFail: {
        color: 'var(--dsw-alias-label-danger, inherit)',
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
      input: {
        font: 'inherit',
        fontSize: '12px',
        padding: '2px 6px',
        minWidth: 0,
        flex: '1 1 160px',
        borderRadius: '4px',
        border: '0.5px solid var(--dsw-alias-border-l2)',
        background: 'transparent',
        color: 'var(--dsw-alias-label-primary)',
      },
      panel: {
        display: 'flex',
        flexDirection: 'column',
        gap: 0,
        padding: 0,
        border: '0.5px solid var(--dsw-alias-border-l2)',
        borderRadius: 14,
        background: 'var(--dsw-alias-bg-module-platform)',
        color: 'var(--dsw-alias-label-primary)',
        overflow: 'hidden',
      },
      panelHeader: {
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        gap: 8,
        padding: '10px 14px',
        borderBottom: '0.5px solid var(--dsw-alias-border-l2)',
        background: 'var(--dsw-alias-bg-l2)',
        flex: '0 0 auto',
      },
      panelTitle: {
        fontSize: 13,
        fontWeight: 600,
        letterSpacing: '0.01em',
        whiteSpace: 'nowrap',
        overflow: 'hidden',
        textOverflow: 'ellipsis',
      },
      panelBody: {
        display: 'flex',
        flexDirection: 'column',
        gap: 12,
        padding: '12px 14px',
        overflowY: 'auto',
        minHeight: 0,
      },
      iconButton: {
        font: 'inherit',
        fontSize: 15,
        lineHeight: 1,
        width: 24,
        height: 24,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        padding: 0,
        borderRadius: 6,
        border: 'none',
        background: 'transparent',
        color: 'var(--dsw-alias-label-tertiary)',
        cursor: 'pointer',
        flex: '0 0 auto',
      },
      overlay: {
        position: 'fixed',
        bottom: 16,
        right: 20,
        zIndex: 30,
        width: 'min(420px, calc(100vw - 40px))',
        pointerEvents: 'auto',
        maxHeight: 'calc(100vh - 120px)',
        boxSizing: 'border-box',
        boxShadow: '0 12px 40px rgba(0, 0, 0, 0.28)',
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
      // A uid is what the token document carries and it is unreadable; a label
      // the user typed, or the nickname decrypted at import, is what they can
      // tell apart at a glance.
      return account.label || account.nickname || shortUid(account.uid);
    }

    /** Shared data layer: loads the account list and exposes the actions. */
    function useAccounts() {
      const [state, setState] = react.useState(undefined);
      const [error, setError] = react.useState(undefined);
      const [busy, setBusy] = react.useState(undefined);
      const [ok, setOk] = react.useState(undefined);
      const mounted = react.useRef(false);
      /**
       * The check-in request already in flight, if any.
       *
       * A ref rather than state on purpose: it is read and written inside the
       * click handler itself, so it has to be current at the instant of the
       * click — state would lag a render behind and let the second click of a
       * burst through.
       */
      const pendingCheckin = react.useRef(undefined);
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
            // Toggling check-in touches nothing the model catalog knows about,
            // so it must not pay for a provider refresh nor claim one happened.
            // Renaming is the same: local bookkeeping only.
            if (body.action === 'set-checkin') {
              setOk(body.enabled === true ? zh.checkinOn : zh.checkinOff);
              await load();
              return;
            }
            if (body.action === 'rename') {
              setOk(zh.renamed);
              await load();
              return;
            }
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
       * Collect today's check-in credits, for one account or for all of them.
       *
       * Posts to the plugin's own route so the host does the network work with
       * the archive's own token; the browser only reports what came back. The
       * claim endpoint is idempotent, so a double click costs a wasted request
       * and cannot duplicate credits.
       *
       * Clicks are coalesced here as well as on the host, because a rapid burst
       * of them is easy to produce and each one would otherwise be a separate
       * round trip. `pendingCheckin` holds the request that is already running;
       * a click during it waits for that result instead of starting another.
       *
       * @param file - archive to collect, or undefined for every account.
       */
      const checkin = react.useCallback(
        async (file) => {
          if (pendingCheckin.current !== undefined) return pendingCheckin.current;
          const label = file === undefined ? 'checkin-all' : `checkin:${file}`;
          setBusy(label);
          setOk(undefined);
          setError(undefined);
          pendingCheckin.current = (async () => {
            try {
              const response = await fetch(ROUTE, {
                method: 'POST',
                credentials: 'same-origin',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ action: 'checkin', ...(file === undefined ? {} : { file }) }),
              });
              const value = await response.json().catch(() => undefined);
              if (!response.ok) throw new Error(value?.error ?? `HTTP ${response.status}`);
              const records = Object.values(value?.results ?? {});
              const claimed = records.filter((record) => record?.result === 'claimed').length;
              const done = records.filter(
                (record) => record?.result === 'claimed' || record?.result === 'already',
              ).length;
              if (!mounted.current) return;
              setOk(zh.checkinDone(claimed, done, records.length));
              await load();
            } catch (failure) {
              if (!mounted.current) return;
              setError(failure instanceof Error ? failure.message : String(failure));
            } finally {
              pendingCheckin.current = undefined;
              if (mounted.current) setBusy(undefined);
            }
          })();
          return pendingCheckin.current;
        },
        [load],
      );

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
        checkin,
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

    /**
     * Wording for one account's check-in badge.
     *
     * Every state the host can report has its own line, because "did my daily
     * credits arrive?" is the whole reason this feature exists and a generic
     * "failed" would leave the user checking the WorkBuddy app by hand.
     *
     * @param record - `state.checkin.accounts[file]`, or null/undefined.
     * @returns `{ text, failed }`, or undefined when there is nothing to show.
     */
    function checkinBadge(record) {
      if (record === undefined || record === null) return undefined;
      const result = record.result;
      const streak = typeof record.streakDays === 'number' ? record.streakDays : undefined;
      // A record from a previous day is history: say it is waiting for today's
      // run rather than let yesterday's "+100" look like today's.
      if (record.today !== true) return undefined;
      if (result === 'claimed') {
        return { text: zh.checkinClaimed(record.credit ?? 100, streak), failed: false };
      }
      if (result === 'already') {
        return { text: zh.checkinAlready(record.credit, streak), failed: false };
      }
      if (result === 'inactive') {
        return {
          text:
            typeof record.endTime === 'string'
              ? `${zh.checkinInactive} · ${record.endTime.slice(0, 10)} 结束`
              : zh.checkinInactive,
          failed: false,
        };
      }
      if (result === 'region') return { text: zh.checkinRegion, failed: false };
      if (result === 'pending') return { text: zh.checkinPending, failed: false };
      return {
        text: `${zh.checkinFailed} · ${zh.checkinResult[result] ?? result}`,
        failed: true,
      };
    }

    /** How many accounts are settled for today, out of the applicable ones. */
    function checkinTally(state) {
      const accounts = state?.accounts ?? [];
      const records = state?.checkin?.accounts ?? {};
      let done = 0;
      let total = 0;
      for (const account of accounts) {
        if (account.region === 'global') continue;
        total += 1;
        const result = records[account.file]?.result;
        if (result === 'claimed' || result === 'already') done += 1;
      }
      return { done, total };
    }

    /** The account list body shared by the settings card and the floating panel. */
    function AccountList({ view, compact }) {
      const { state, busy, run, checkin } = view;
      const [confirming, setConfirming] = react.useState(undefined);
      const [renaming, setRenaming] = react.useState(undefined);
      const [draft, setDraft] = react.useState('');
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
          // Named `badge`, not `checkin`: the action callback sharing that name
          // is what the row's button calls, and shadowing it would make the
          // button throw instead of collecting credits.
          const badge = checkinBadge(state?.checkin?.accounts?.[account.file]);
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
                    badge === undefined
                      ? null
                      : jsx('span', {
                          style: {
                            ...styles.tag,
                            ...styles.tagCheckin,
                            ...(badge.failed ? styles.tagCheckinFail : {}),
                          },
                          title: state?.checkin?.accounts?.[account.file]?.reason || zh.checkinHint,
                          children: badge.text,
                        }),
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
                        renaming === account.file
                          ? jsxs('span', {
                              style: styles.row,
                              children: [
                                jsx('input', {
                                  style: styles.input,
                                  value: draft,
                                  maxLength: 40,
                                  placeholder: labelOf(account),
                                  autoFocus: true,
                                  onChange: (event) => setDraft(event.target.value),
                                  onKeyDown: (event) => {
                                    if (event.key === 'Escape') setRenaming(undefined);
                                    if (event.key === 'Enter') {
                                      setRenaming(undefined);
                                      run('rename', { action: 'rename', file: account.file, label: draft });
                                    }
                                  },
                                }),
                                jsx('button', {
                                  type: 'button',
                                  style: styles.buttonPrimary,
                                  disabled: busy !== undefined,
                                  onClick: () => {
                                    setRenaming(undefined);
                                    run('rename', { action: 'rename', file: account.file, label: draft });
                                  },
                                  children: zh.renameSave,
                                }),
                              ],
                            })
                          : jsxs('span', {
                              style: styles.row,
                              children: [
                                jsx('button', {
                                  type: 'button',
                                  style: styles.buttonDanger,
                                  disabled: busy !== undefined,
                                  title: zh.renameHint,
                                  onClick: () => {
                                    setDraft(account.label || account.nickname || '');
                                    setRenaming(account.file);
                                  },
                                  children: zh.rename,
                                }),
                                jsx('span', { style: styles.mono, children: account.uid || '—' }),
                              ],
                            }),
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
                    // A manual check-in is offered whatever today's state is:
                    // it is how the user answers "the badge looks wrong" and how
                    // they collect an account that was added after the sweep.
                    account.region === 'global'
                      ? null
                      : jsx('button', {
                          type: 'button',
                          style: styles.button,
                          title: zh.checkinHint,
                          disabled: busy !== undefined,
                          onClick: () => void checkin(account.file),
                          children: busy === `checkin:${account.file}` ? zh.checkinBusy : zh.checkinOne,
                        }, `checkin:${account.file}`),
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
      const { state, busy, run, error, ok, refreshModels, exportBundle, importBundleFile, checkin } = view;
      const selectedFile = state?.selectedFile ?? null;
      const accounts = state?.accounts ?? [];
      const selected = accounts.find((account) => account.file === selectedFile);
      const tally = checkinTally(state);
      const checkinEnabled = state?.checkin?.enabled !== false;

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
              // One glance answers "are my daily credits in?" without reading
              // every row.
              tally.total === 0
                ? null
                : jsx('span', {
                    style: styles.tag,
                    children: zh.checkinSummary(tally.done, tally.total),
                  }),
              typeof state?.activeModel === 'string' && state.activeModel !== ''
                ? jsx('span', {
                    style: styles.tag,
                    title: zh.cooldownModelHint,
                    children: `${zh.cooldownModel}: ${shortModel(state.activeModel)}`,
                  })
                : null,
              // A hand-picked account stays put for a day. Say so, otherwise the
              // absence of the usual reclaim looks like the sweep is broken.
              typeof state?.holdUntilMs === 'number'
                ? jsx('span', {
                    style: styles.tag,
                    title: zh.holdHint,
                    children: `${zh.holdUntil} ${fmtClock(state.holdUntilMs)}`,
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
              jsx('button', {
                type: 'button',
                style: styles.button,
                disabled: busy !== undefined || tally.total === 0,
                title: zh.checkinHint,
                onClick: () => void checkin(undefined),
                children: busy === 'checkin-all' ? zh.checkinBusy : zh.checkinAll,
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
          jsxs('label', {
            style: styles.checkbox,
            title: zh.checkinHint,
            children: [
              jsx('input', {
                type: 'checkbox',
                checked: checkinEnabled,
                disabled: busy !== undefined,
                onChange: (event) =>
                  run('set-checkin', {
                    action: 'set-checkin',
                    enabled: event.target.checked === true,
                  }),
              }),
              jsxs('span', {
                children: [
                  zh.checkin,
                  jsx('span', {
                    style: styles.note,
                    children: ` — ${zh.checkinHint}${
                      typeof state?.checkin?.lastSweepAt === 'number'
                        ? `（上次 ${fmtClock(state.checkin.lastSweepAt)}）`
                        : ''
                    }`,
                  }),
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
      const positionKey = 'dsh-workbuddy-switcher:fab-position';
      const [position, setPosition] = react.useState(() => {
        try {
          const saved = JSON.parse(localStorage.getItem(positionKey));
          if (Number.isFinite(saved?.right) && Number.isFinite(saved?.bottom)) {
            const restore =
              Number.isFinite(saved.restore?.right) && Number.isFinite(saved.restore?.bottom)
                ? { right: saved.restore.right, bottom: saved.restore.bottom }
                : undefined;
            return { right: saved.right, bottom: saved.bottom, snapped: saved.snapped === true, restore };
          }
        } catch { /* Storage may be unavailable. */ }
        return { right: 20, bottom: 16, snapped: false, restore: undefined };
      });
      const buttonRef = react.useRef(null);
      const panelRef = react.useRef(null);
      const drag = react.useRef(null);
      const suppressClick = react.useRef(false);
      // Parked launcher, hovered. Kept apart from `position` so a peek never
      // gets saved as the resting place, and so the CSS transition has one
      // value to animate towards.
      const [peek, setPeek] = react.useState(false);
      /**
       * Height of the window's own drag handle, which on DSH Windows is the
       * title bar. Dropped inside it, the launcher never receives the pointer
       * again and only the window can be dragged, so its top edge stops below.
       * Same variable DSH's floating panes read.
       */
      const topGuard = () => {
        const root = typeof document === 'undefined' ? undefined : document.documentElement;
        if (root === undefined || root === null || !root.hasAttribute('data-windows-titlebar')) return 0;
        if (root.hasAttribute('data-fullscreen')) return 0;
        const value = Number.parseFloat(root.style.getPropertyValue('--dsh-windows-titlebar-height'));
        return Number.isFinite(value) && value > 0 ? value : 0;
      };
      const clampPosition = (next) => {
        const rect = buttonRef.current?.getBoundingClientRect();
        const top = topGuard();
        return {
          right: Math.max(8, Math.min(next.right, window.innerWidth - (rect?.width ?? 0) - 8)),
          bottom: Math.max(
            top + 8,
            Math.min(next.bottom, window.innerHeight - (rect?.height ?? 0) - top - 8),
          ),
          snapped: false,
        };
      };
      react.useEffect(() => {
        // A parked launcher is deliberately off-screen; clamping it back would
        // undo the snap on every resize.
        const fit = () => setPosition((previous) => (previous.snapped ? previous : clampPosition(previous)));
        fit();
        window.addEventListener('resize', fit);
        const observer = new ResizeObserver(fit);
        observer.observe(buttonRef.current);
        return () => {
          window.removeEventListener('resize', fit);
          observer.disconnect();
        };
      }, []);
      react.useEffect(() => {
        if (drag.current?.moved) return;
        try { localStorage.setItem(positionKey, JSON.stringify(position)); } catch { /* Best effort. */ }
      }, [position]);
      /**
       * Park the launcher against the side it was released nearest to, showing
       * only its dot — the 360-ball shape: out of the way, one click from back.
       * A parked position is expressed the same way as a free one (an offset
       * past the edge), so one storage key and one clamp keep working.
       */
      const snapPosition = (current) => {
        const top = topGuard();
        const width = buttonRef.current?.getBoundingClientRect().width ?? SNAP_SIZE;
        // `right` is measured from the viewport's right edge, so a small value
        // means "near the right side".
        const parkLeft = window.innerWidth - current.right - width / 2 < window.innerWidth / 2;
        return {
          right: parkLeft ? window.innerWidth - SNAP_SIZE / 2 : -SNAP_SIZE / 2,
          bottom: Math.max(top + 8, Math.min(current.bottom, window.innerHeight - SNAP_SIZE - top - 8)),
          snapped: true,
          // Where the click brings the full pill back: against the same edge it
          // parked on, so the launcher does not jump across the screen.
          restore: { right: parkLeft ? window.innerWidth - width - 20 : 20, bottom: current.bottom },
        };
      };
      const finishDrag = (event, park) => {
        if (drag.current?.id !== event.pointerId) return;
        const { moved } = drag.current;
        drag.current = null;
        suppressClick.current = moved;
        // A cancelled gesture (the browser took the pointer away) leaves the
        // launcher where it is; only a real release parks it.
        if (moved && park) setPosition((previous) => snapPosition(previous));
      };
      /**
       * Close on a press anywhere outside the panel, and on Escape.
       *
       * A press, not a click: dragging inside the panel (selecting text, the
       * pointer leaving and re-entering) ends its click on the panel itself, so
       * a click listener would work, but a press that starts outside and ends
       * inside would not close. Escape is here for keyboards; the launcher's
       * own press is excluded because its click handler toggles instead.
       */
      react.useEffect(() => {
        if (!open) return undefined;
        const outside = (event) => {
          if (panelRef.current?.contains(event.target)) return;
          if (buttonRef.current?.contains(event.target)) return;
          setOpen(false);
        };
        const escape = (event) => {
          if (event.key === 'Escape') setOpen(false);
        };
        document.addEventListener('pointerdown', outside, true);
        document.addEventListener('keydown', escape);
        return () => {
          document.removeEventListener('pointerdown', outside, true);
          document.removeEventListener('keydown', escape);
        };
      }, [open]);
      const buttonHeight = buttonRef.current?.getBoundingClientRect().height ?? SNAP_SIZE;
      // A parked dot slides back out on hover, so it can be read and clicked
      // without first clicking it out. `open` keeps it out while the panel is up.
      const peeked = position.snapped && (peek || open);
      const shown = peeked
        ? clampPosition(position.restore ?? { right: 20, bottom: position.bottom })
        : position;
      // The panel opens toward whichever side has more room, measured in the
      // space it may actually use: the title bar is not the panel's to cover.
      const panelTop = topGuard() + 8;
      // Upward, the ceiling is the title bar; downward, it is the window edge.
      const roomAbove = window.innerHeight - shown.bottom - buttonHeight - 8 - panelTop;
      const roomBelow = shown.bottom - 16;
      const opensUp = roomAbove >= roomBelow;
      const panelWidth = Math.min(420, window.innerWidth - 40);
      const panelPosition = {
        right: Math.max(
          20,
          Math.min(
            // A parked launcher sits past the edge it is parked on, so the
            // panel anchors to that edge instead of following it off-screen.
            shown.snapped
              ? shown.right < 0
                ? 20
                : window.innerWidth - panelWidth - 20
              : shown.right,
            window.innerWidth - panelWidth - 20,
          ),
        ),
        ...(opensUp
          ? { bottom: shown.bottom + buttonHeight + 8 }
          : { bottom: 'auto', top: window.innerHeight - shown.bottom + 8 }),
        // Whichever way it opened, it stops at the title bar and reflows inside.
        maxHeight: Math.max(120, Math.min(opensUp ? roomAbove : roomBelow, window.innerHeight - panelTop)),
      };
      const { state } = view;
      const selectedFile = state?.selectedFile ?? null;
      const selected = (state?.accounts ?? []).find((account) => account.file === selectedFile);

      const badge = selected === undefined ? zh.noActive : labelOf(selected);

      return jsxs(react.Fragment, {
        children: [
          jsx('button', {
            type: 'button',
            ref: buttonRef,
            style: {
              ...styles.fab,
              right: shown.right,
              bottom: shown.bottom,
              ...(peeked
                ? {}
                : position.snapped
                  ? {
                      width: SNAP_SIZE,
                      height: SNAP_SIZE,
                      padding: 0,
                      justifyContent: 'center',
                      borderRadius: '50%',
                      gap: 0,
                    }
                  : {}),
              // Parked, only the slide is animated: padding would reflow mid-way.
              ...(position.snapped
                ? { transition: 'right 160ms ease-out, bottom 160ms ease-out' }
                : {}),
              touchAction: 'none',
              userSelect: 'none',
              cursor: 'move',
              maxWidth: 'calc(100vw - 16px)',
              boxSizing: 'border-box',
            },
            title: position.snapped ? zh.fabExpand : zh.fabLabel,
            'aria-label': zh.fabLabel,
            'aria-expanded': open,
            onPointerEnter: (event) => {
              if (position.snapped && event.pointerType !== 'touch') setPeek(true);
            },
            onPointerLeave: () => setPeek(false),
            onPointerDown: (event) => {
              if (!event.isPrimary || event.button !== 0) return;
              suppressClick.current = false;
              // Dragging a parked dot has to start from its full-width spot,
              // otherwise the launcher grows out from under the cursor.
              const start = position.snapped
                ? clampPosition(position.restore ?? { right: 20, bottom: position.bottom })
                : position;
              if (position.snapped) setPosition(start);
              drag.current = { id: event.pointerId, x: event.clientX, y: event.clientY, ...start, moved: false };
              event.currentTarget.setPointerCapture(event.pointerId);
            },
            onPointerMove: (event) => {
              const start = drag.current;
              if (start?.id !== event.pointerId) return;
              const dx = event.clientX - start.x;
              const dy = event.clientY - start.y;
              if (!start.moved && Math.hypot(dx, dy) < 5) return;
              start.moved = true;
              setPosition(clampPosition({ right: start.right - dx, bottom: start.bottom - dy }));
            },
            onPointerUp: (event) => finishDrag(event, true),
            onPointerCancel: (event) => finishDrag(event, false),
            onLostPointerCapture: (event) => finishDrag(event, false),
            onClick: (event) => {
              if (suppressClick.current && event.detail !== 0) {
                suppressClick.current = false;
                return;
              }
              // Parked, the launcher is a dot: its click is the only way back in.
              if (position.snapped && !open) {
                setPosition(clampPosition(position.restore ?? { right: 20, bottom: position.bottom }));
                setPeek(false);
              }
              setOpen((previous) => !previous);
            },
            children: [
              jsx('span', { style: styles.fabDot }),
              position.snapped && !peeked
                ? null
                : jsx('span', { style: { overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }, children: `WorkBuddy · ${badge}` }),
            ],
          }),
          open
            ? jsx('div', {
                style: { ...styles.panel, ...styles.overlay, ...panelPosition },
                role: 'dialog',
                'aria-modal': false,
                'aria-label': zh.title,
                ref: panelRef,
                children: [
                  jsxs('div', {
                    style: styles.panelHeader,
                    children: [
                      jsx('span', { style: styles.panelTitle, children: zh.title }),
                      jsx('button', {
                        type: 'button',
                        style: styles.iconButton,
                        title: zh.close,
                        'aria-label': zh.close,
                        onClick: () => setOpen(false),
                        children: '✕',
                      }),
                    ],
                  }),
                  jsxs('div', {
                    style: styles.panelBody,
                    children: [jsx(Footer, { view }), jsx(AccountList, { view, compact: true })],
                  }),
                ],
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
