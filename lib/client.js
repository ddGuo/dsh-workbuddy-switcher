window.__ModuleLoader__.load({
  id: 'dsh-workbuddy-switcher',
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' });

    const react = require('react');
    const jsxRuntime = require('react/jsx-runtime');
    const { jsx, jsxs } = jsxRuntime;

    /**
     * The bundled bridge's client module, if the shipped bundle was assembled.
     *
     * `scripts/build-client.mjs` concatenates the bridge's client bundle ahead
     * of this one and parks each factory it registers in a map, so this half can
     * mount that UI itself. Resolving it from the loader registry instead would
     * depend on how DSH keys registrations, which is not this plugin's contract.
     */
    const bridgeFactory = window.__DSH_BUNDLED_BRIDGE_CLIENTS__?.get?.('dsh-workbuddy-connect');
    let bridgeClient;
    if (typeof bridgeFactory === 'function') {
      try {
        bridgeClient = bridgeFactory(require);
      } catch (error) {
        console.error('dsh-workbuddy-switcher: bundled WorkBuddy UI failed to load', error);
      }
    }

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
      clearShort: '解除',
      // A cooldown badge carries the button that clears it, so the visible text
      // only has to say "undo this one": the scope is the badge right next to it.
      clearCooldownHint: '额度已恢复时点这里，清掉整个账号的冷却',
      clearAccountLabel: '解除冷却：账号额度',
      clearModelLabel: (model) => `解除该模型冷却：${model}`,
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
      // A rejected refresh token is not something waiting fixes: the account has
      // to be signed in again and imported. Saying 「令牌失效」 alone left people
      // retrying an account that could never recover, so the row owns the verb.
      dead: '需重新登录',
      deadHint: 'WorkBuddy 拒绝了该账号的刷新令牌，等待不会恢复。在客户端登录该账号后点「导入当前账号」；在此之前它不会参与自动换号。',
      reimport: '重新导入',
      reimportHint: '用 WorkBuddy 客户端当前的登录覆盖这个存档的令牌。先在客户端登录这个账号，再点这里。',
      reimported: (name) => `已用客户端的登录覆盖 ${name} 的令牌，失效标记已清除。`,
      reimportSame: '客户端当前登录的不是这个账号，未覆盖。',
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
      /**
       * One cooldown badge plus the button that clears exactly that cooldown.
       *
       * They are one inline-flex group on purpose: a row that wraps can break
       * between any two spans, and a clear button that ends up one line away from
       * its badge — next to a different model's badge — is indistinguishable from
       * the bug this pairing fixes. Keeping them nowrap and together makes the
       * association visual rather than textual.
       */
      cooldownGroup: {
        display: 'inline-flex',
        alignItems: 'center',
        gap: '4px',
        flexWrap: 'nowrap',
        // Shrink as a unit when the panel is narrow (the floating popover is
        // `min(420px, 100vw - 40px)`), so a long model id cannot push the chip
        // out of the card. The badge's own text is what gives way, never the
        // badge/chip pairing.
        flex: '0 1 auto',
        minWidth: 0,
        maxWidth: '100%',
      },
      /**
       * The badge inside {@link cooldownGroup}; wraps its own text when squeezed.
       *
       * `styles.tag` alone leaves the text on one line, which combined with the
       * group's nowrap would overflow a narrow popover rather than reflow.
       */
      cooldownTag: {
        whiteSpace: 'normal',
        overflowWrap: 'anywhere',
        minWidth: 0,
      },
      /** Compact「解除」chip that sits inside {@link cooldownGroup}. */
      tagButton: {
        font: 'inherit',
        fontSize: '11px',
        lineHeight: '16px',
        padding: '0 6px',
        borderRadius: '4px',
        border: '0.5px solid var(--dsw-alias-border-l2)',
        background: 'transparent',
        color: 'var(--dsw-alias-label-secondary)',
        cursor: 'pointer',
        // The chip keeps its width; it is the fixed end of the pair.
        flex: '0 0 auto',
        whiteSpace: 'nowrap',
      },
      tagButtonBusy: { opacity: 0.55, cursor: 'default' },
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

    /**
     * The row title for one account: its masked phone when known.
     *
     * Every account is the same kind of thing — a WorkBuddy login — so the uid
     * says nothing a user can act on, while the phone is how they recognise the
     * account they just added. WorkBuddy only ever exposes the masked form
     * (`180****0331`), so that is all this ever shows; archives captured before
     * the phone was recorded still fall back to the short uid.
     *
     * @param account - one row from `state.accounts`.
     * @returns the label to render.
     */
    function labelOf(account) {
      // `accountLabel` lives in ./format.js so the host and the archive shapes
      // share one rule; this mirror exists because the client bundle is built
      // from this file alone and cannot import the host module.
      const nickname = typeof account.nickname === 'string' ? account.nickname.trim() : '';
      // Accept the masked form only: a future WorkBuddy build that starts sending
      // a full number must not have it rendered (or logged) by this plugin.
      const masked = /^(?:\+?86[-\s]?)?(\d{3})\*{2,6}(\d{4})$/.exec(nickname);
      if (masked !== null) return `${masked[1]}****${masked[2]}`;
      return shortUid(account.uid);
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

      // Poll the archive directory, so an account signed in through the desktop
      // app appears without the user pressing anything. The host's own sweep
      // archives a new login within ~20 s; this poll is what makes the result
      // visible without a reload.
      react.useEffect(() => {
        const timer = window.setInterval(() => {
          void (async () => {
            const next = await load();
            if (next === undefined || !mounted.current) return;
            // The phone label arrives later than the file for an older archive
            // (the host backfills it when that account is signed in again), so
            // the signature covers the label as well as the file set — otherwise
            // a row would keep showing its uid until the next reload.
            const signature = (next.accounts ?? [])
              .map((account) => `${account.file}:${account.nickname ?? ''}`)
              .join('|');
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
            if (body.action === 'set-checkin') {
              setOk(body.enabled === true ? zh.checkinOn : zh.checkinOff);
              await load();
              return;
            }
            // A replace-import rewrote an archive's tokens, so the provider has
            // to re-read the credential; but the answer is more specific than
            // 「已导入新账号」 and says whether anything was actually replaced.
            if (body.action === 'import' && body.replace === true) {
              if (value?.file !== undefined) {
                refreshModelPicker();
                setOk(zh.reimported(value.nickname ?? value.uid ?? value.file));
              } else {
                setOk(zh.reimportSame);
              }
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
                    // A dead login is a state of the *account*, not of today's
                    // check-in, so it gets its own badge whether or not the
                    // sweep produced a record.
                    account.dead === true
                      ? jsx('span', {
                          style: { ...styles.tag, ...styles.tagCheckin, ...styles.tagCheckinFail },
                          title: account.deadHint ?? zh.deadHint,
                          children: zh.dead,
                        })
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
                    // One group per live cooldown: the badge and the button that
                    // clears exactly that scope travel together. They used to be
                    // rendered apart — badges here, clear buttons in the action
                    // bar — which made two model-scoped cooldowns produce two
                    // identical 「解除该模型冷却」 buttons with nothing saying
                    // which model each would unbench.
                    scopes.map((scope) => {
                      const label = `clear-cooldown:${account.file}:${scope.model ?? ''}`;
                      return jsxs(
                        'span',
                        {
                          style: styles.cooldownGroup,
                          // Machine-readable pair for tests and for a future
                          // tooltip layer: 'account' or the model id.
                          'data-cooldown': scope.model === null ? 'account' : scope.model,
                          children: [
                            jsx('span', {
                              style: {
                                ...styles.tag,
                                ...styles.tagCooling,
                                ...styles.cooldownTag,
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
                            }),
                            jsx('button', {
                              type: 'button',
                              style: {
                                ...styles.tagButton,
                                ...(busy !== undefined ? styles.tagButtonBusy : {}),
                              },
                              // The visible text is the same for every scope, so
                              // the accessible name and the tooltip carry the
                              // target: the badge sidesteps the ambiguity, these
                              // two make it explicit for screen readers.
                              title:
                                scope.model === null
                                  ? (scope.reason ?? zh.clearCooldownHint)
                                  : zh.cooldownModelHint,
                              'aria-label':
                                scope.model === null
                                  ? zh.clearAccountLabel
                                  : zh.clearModelLabel(scope.model),
                              disabled: busy !== undefined,
                              onClick: () =>
                                run(label, {
                                  action: 'clear-cooldown',
                                  file: account.file,
                                  ...(scope.model === null ? {} : { model: scope.model }),
                                }),
                              children: zh.clearShort,
                            }),
                          ],
                        },
                        `${account.file}:${scope.model ?? '*'}@${scope.untilMs}`,
                      );
                    }),
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
                    // Cooldowns are cleared from their own badge above, one
                    // button per scope, so this bar stays account-level only.
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
                    // Only a dead row needs this. Importing is not a replacement
                    // for the sweep's phone patch: there the app's older tokens
                    // must be ignored, while here they are the whole point.
                    account.dead === true
                      ? jsx('button', {
                          type: 'button',
                          style: styles.button,
                          title: zh.reimportHint,
                          disabled: busy !== undefined,
                          onClick: () =>
                            run(`reimport:${account.file}`, {
                              action: 'import',
                              replace: true,
                              uid: account.uid,
                            }),
                          children: busy === `reimport:${account.file}` ? zh.loading : zh.reimport,
                        }, `reimport:${account.file}`)
                      : null,
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
            return { right: saved.right, bottom: saved.bottom };
          }
        } catch { /* Storage may be unavailable. */ }
        return { right: 20, bottom: 16 };
      });
      const buttonRef = react.useRef(null);
      const drag = react.useRef(null);
      const suppressClick = react.useRef(false);
      const clampPosition = (next) => {
        const rect = buttonRef.current?.getBoundingClientRect();
        return {
          right: Math.max(8, Math.min(next.right, window.innerWidth - (rect?.width ?? 0) - 8)),
          bottom: Math.max(8, Math.min(next.bottom, window.innerHeight - (rect?.height ?? 0) - 8)),
        };
      };
      react.useEffect(() => {
        const fit = () => setPosition((previous) => clampPosition(previous));
        fit();
        window.addEventListener('resize', fit);
        const observer = new ResizeObserver(fit);
        observer.observe(buttonRef.current);
        return () => {
          window.removeEventListener('resize', fit);
          observer.disconnect();
        };
      }, []);
      const savePosition = () => {
        try { localStorage.setItem(positionKey, JSON.stringify(position)); } catch { /* Best effort. */ }
      };
      react.useEffect(() => {
        if (!drag.current?.moved) savePosition();
      }, [position]);
      const finishDrag = (event) => {
        if (drag.current?.id !== event.pointerId) return;
        suppressClick.current = drag.current.moved;
        drag.current = null;
        savePosition();
      };
      const buttonHeight = buttonRef.current?.getBoundingClientRect().height ?? 36;
      const above = window.innerHeight - position.bottom - buttonHeight - 16;
      const below = position.bottom - 16;
      const panelPosition = {
        right: Math.max(20, Math.min(position.right, window.innerWidth - Math.min(420, window.innerWidth - 40) - 20)),
        ...(above >= below
          ? { bottom: position.bottom + buttonHeight + 8, maxHeight: Math.max(0, above) }
          : { bottom: 'auto', top: window.innerHeight - position.bottom + 8, maxHeight: Math.max(0, below) }),
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
            style: { ...styles.fab, ...position, touchAction: 'none', userSelect: 'none', cursor: 'move', maxWidth: 'calc(100vw - 16px)', boxSizing: 'border-box' },
            title: `${zh.fabLabel}（可拖动）`,
            'aria-label': zh.fabLabel,
            'aria-expanded': open,
            onPointerDown: (event) => {
              if (!event.isPrimary || event.button !== 0) return;
              suppressClick.current = false;
              drag.current = { id: event.pointerId, x: event.clientX, y: event.clientY, ...position, moved: false };
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
            onPointerUp: finishDrag,
            onPointerCancel: finishDrag,
            onLostPointerCapture: finishDrag,
            onClick: (event) => {
              if (suppressClick.current && event.detail !== 0) {
                suppressClick.current = false;
                return;
              }
              setOpen((previous) => !previous);
            },
            children: [
              jsx('span', { style: styles.fabDot }),
              jsx('span', { style: { overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }, children: `WorkBuddy · ${badge}` }),
            ],
          }),
          open
            ? jsx('div', {
                style: { ...styles.panel, ...styles.overlay, ...panelPosition },
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
      // The bundled bridge's own client half: the WorkBuddy settings card, the
      // model-visibility controls, and the probe/heartbeat wiring. It is
      // optional from this plugin's point of view — if the merged bundle was
      // not assembled (a bare source checkout, a unit test), the switcher UI
      // below still mounts on its own rather than failing with it.
      if (bridgeClient !== undefined && typeof bridgeClient.apply === 'function') {
        try {
          bridgeClient.apply(ctx);
        } catch (error) {
          console.error('dsh-workbuddy-switcher: bundled WorkBuddy UI failed to mount', error);
        }
      }

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
    // Union of both halves' service needs: `slots` for the switcher surfaces
    // and the bridge's own list for its settings card and model picker.
    const inject = [
      'slots',
      ...(bridgeClient !== undefined && Array.isArray(bridgeClient.inject) ? bridgeClient.inject : []),
    ];

    exports.name = name;
    exports.inject = inject;
    exports.apply = apply;
    return module.exports;
  },
});
