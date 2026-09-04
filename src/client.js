/**
 * dsh-plugin-session-import client bundle（手写 CJS factory 格式）。
 * 侧边栏"导入会话"按钮 → 弹窗：工具选择 + 会话列表多选 + 批量导入。
 */
window.__ModuleLoader__.load({
  id: "dsh-plugin-session-import",
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
    const React = require("react");
    const { useState, useCallback, useEffect } = React;

    const TOOLS = ["claude-code", "codex", "reasonix", "zcode"];

    // spinner 动画（一次性注入）
    if (typeof document !== "undefined" && !document.querySelector("style[data-dsh-import-spin]")) {
      const tag = document.createElement("style");
      tag.dataset.dshImportSpin = "1";
      tag.textContent = "@keyframes dsh-import-spin { from { transform: rotate(0deg); } to { transform: rotate(360deg); } }";
      document.head.appendChild(tag);
    }

    const isDark = () => typeof document !== 'undefined' && document.body && document.body.hasAttribute('data-ds-dark-theme')
    const themeColors = () => isDark()
      ? { bg: '#1b1f27', border: '#2a3040', field: '#14181f', text: '#e4e8ee', dim: '#9aa3b2', dimmer: '#7a8394', accent: '#4f8cff', hover: '#1f2530' }
      : { bg: '#ffffff', border: '#d8dee6', field: '#f5f6f8', text: '#1f2328', dim: '#57606a', dimmer: '#6e7781', accent: '#0969da', hover: '#eef1f5' }

    const makeStyles = (C) => ({
      dialog: {
        position: "fixed", top: "50%", left: "50%", transform: "translate(-50%, -50%)",
        width: "560px", maxWidth: "90vw", maxHeight: "80vh", display: "flex", flexDirection: "column",
        background: C.bg, border: "1px solid " + C.border, borderRadius: "12px", padding: "16px",
        zIndex: 9999, color: C.text, font: "13px/1.6 system-ui, sans-serif",
        boxShadow: "0 12px 40px rgba(0,0,0,.5)",
      },
      header: { display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "10px" },
      row: { display: "flex", gap: "8px", margin: "8px 0", alignItems: "center" },
      label: { color: C.dim, width: "56px", flex: "none" },
      input: {
        flex: "1", background: C.field, border: "1px solid " + C.border, color: C.text,
        borderRadius: "6px", padding: "7px 10px", fontSize: "13px", outline: "none",
      },
      list: {
        flex: "1", overflowY: "auto", background: C.field, border: "1px solid " + C.border,
        borderRadius: "8px", padding: "6px", marginTop: "10px", minHeight: "160px",
      },
      item: {
        display: "flex", alignItems: "center", gap: "8px", padding: "6px 8px",
        borderRadius: "6px", cursor: "pointer",
      },
      itemTitle: { flex: "1", minWidth: "0", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", fontSize: "12.5px" },
      itemMeta: { color: C.dimmer, fontSize: "11px", flex: "none" },
      btn: {
        background: C.accent, border: "none", color: "#fff", borderRadius: "6px",
        padding: "8px 18px", fontSize: "13px", cursor: "pointer",
      },
      btnGhost: {
        background: "transparent", border: "1px solid " + C.border, color: C.dim,
        borderRadius: "6px", padding: "6px 12px", fontSize: "12px", cursor: "pointer",
      },
      footer: { display: "flex", gap: "8px", marginTop: "12px", justifyContent: "space-between", alignItems: "center" },
      result: {
        marginTop: "10px", whiteSpace: "pre-wrap", fontSize: "12px", maxHeight: "140px",
        overflow: "auto", background: C.field, borderRadius: "6px", padding: "10px",
      },
    });

    function fmtTime(ts) {
      if (!ts) return "";
      const d = new Date(ts);
      return `${d.getMonth() + 1}-${d.getDate()} ${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
    }

    /** 导入对话框：工具选择 → 会话列表多选 → 批量导入 */
    function ImportDialog({ onClose }) {
      const colors = themeColors()
      const style = makeStyles(colors)
      const [tool, setTool] = useState(TOOLS[0]);
      const [sessions, setSessions] = useState(null);
      const [selected, setSelected] = useState({});
      const [busy, setBusy] = useState(false);
      const [result, setResult] = useState(null);
      const [loading, setLoading] = useState(false);
      const [loadingMore, setLoadingMore] = useState(false);
      const [offset, setOffset] = useState(0);
      const [hasMore, setHasMore] = useState(true);

      const BATCH = 10
      const loadSessions = useCallback(async (t, startOffset) => {
        if (startOffset === 0) {
          setLoading(true);
          setSessions([]);
          setSelected({});
          setResult(null);
          setHasMore(true);
        } else {
          setLoadingMore(true);
        }
        try {
          const resp = await fetch("/api-import/list", {
            method: "POST", headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ tool: t, offset: startOffset, limit: BATCH }),
          });
          const data = await resp.json();
          const batch = data.sessions ?? [];
          setSessions((prev) => (startOffset === 0 ? batch : [...(prev ?? []), ...batch]));
          setOffset(startOffset + batch.length);
          if (batch.length < BATCH) setHasMore(false);
        } catch (e) {
          setResult({ ok: false, text: `会话列表加载失败：${e.message}` });
        } finally {
          setLoading(false);
          setLoadingMore(false);
        }
      }, []);

      useEffect(() => { loadSessions(tool, 0); }, [tool, loadSessions]);

      const toggle = (path) => {
        setSelected((prev) => ({ ...prev, [path]: !prev[path] }));
      };

      const selectAll = () => {
        if (!sessions) return;
        const allSelected = sessions.every((s) => selected[s.path]);
        setSelected(allSelected ? {} : Object.fromEntries(sessions.map((s) => [s.path, true])));
      };

      const doImport = async () => {
        const paths = Object.entries(selected).filter(([, v]) => v).map(([p]) => p);
        if (paths.length === 0 || busy) return;
        setBusy(true);
        setResult(null);
        try {
          const resp = await fetch("/api-import/batch", {
            method: "POST", headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ tool, paths }),
          });
          const data = await resp.json();
          if (data.ok) {
            const lines = data.imported.map((r) => `  ✓ ${r.sessionId}（${r.messages} 条${r.cwd ? `，工作区 ${r.cwd}` : ""}）`);
            const failed = data.failed.length > 0 ? `\n失败 ${data.failed.length} 个：\n` + data.failed.slice(0, 5).map((f) => `  ✗ ${f.path.split(/[\\/]/).pop()}: ${f.error}`).join("\n") : "";
            setResult({ ok: true, text: `导入完成：成功 ${data.imported.length}/${paths.length}\n` + lines.join("\n") + failed });
          } else {
            setResult({ ok: false, text: `导入失败：${data.error}` });
          }
        } catch (e) {
          setResult({ ok: false, text: `请求失败：${e.message}` });
        } finally {
          setBusy(false);
        }
      };

      const selectedCount = Object.values(selected).filter(Boolean).length;

      return React.createElement("div", { style: style.dialog },
        React.createElement("div", { style: style.header },
          React.createElement("b", null, "导入会话"),
          React.createElement("button", { style: style.btnGhost, onClick: onClose }, "✕")),

        React.createElement("div", { style: style.row },
          React.createElement("span", { style: style.label }, "工具"),
          React.createElement("select", { style: style.input, value: tool, onChange: (e) => setTool(e.target.value) },
            TOOLS.map((t) => React.createElement("option", { key: t, value: t }, t)))),

        React.createElement("div", { style: style.list, onScroll: (e) => {
            const el = e.currentTarget;
            if (hasMore && !loading && !loadingMore && el.scrollTop + el.clientHeight >= el.scrollHeight - 40) {
              loadSessions(tool, offset);
            }
          } },
          loading && React.createElement("div", { style: { color: "var(--dsw-alias-label-secondary, #7a8394)", padding: "24px", textAlign: "center" } },
            React.createElement("span", { style: { display: "inline-block", width: "14px", height: "14px", border: "2px solid " + colors.border, borderTopColor: colors.accent, borderRadius: "50%", animation: "dsh-import-spin 0.8s linear infinite", marginRight: "8px", verticalAlign: "middle" } }),
            "记忆正在找回中…"),
          !loading && sessions === null && React.createElement("div", { style: { color: colors.dimmer, padding: "20px", textAlign: "center" } }, "加载失败"),
          !loading && sessions !== null && sessions.length === 0 && React.createElement("div", { style: { color: colors.dimmer, padding: "20px", textAlign: "center" } }, "该工具没有找到会话"),
          !loading && sessions !== null && sessions.length > 0 && [
            React.createElement("div", { key: "all", style: { ...style.item, borderBottom: "1px solid #2a3040", marginBottom: "4px" } },
              React.createElement("input", { type: "checkbox", checked: sessions.every((s) => selected[s.path]), onChange: selectAll }),
              React.createElement("span", { style: { ...style.itemTitle, color: "#9aa3b2" } }, "全选"),
              React.createElement("span", { style: style.itemMeta }, `${sessions.length} 个`)),
            sessions.map((s) => React.createElement("div", {
              key: s.path, style: style.item, onClick: () => toggle(s.path),
              onMouseEnter: (e) => { e.currentTarget.style.background = colors.hover; },
              onMouseLeave: (e) => { e.currentTarget.style.background = "transparent"; },
            },
              React.createElement("input", { type: "checkbox", checked: !!selected[s.path], onChange: () => toggle(s.path), onClick: (e) => e.stopPropagation() }),
              React.createElement("span", { style: style.itemTitle, title: s.path }, s.title || "(无标题)"),
              React.createElement("span", { style: style.itemMeta }, `${s.messageCount} 条 · ${fmtTime(s.updatedAt)}`))),
          ]),

        result && React.createElement("pre", {
          style: { ...style.result, color: result.ok ? "#1a7f37" : "#cf222e" },
        }, result.text),

        React.createElement("div", { style: style.footer },
          React.createElement("span", { style: { color: "#7a8394", fontSize: "12px" } }, `已选 ${selectedCount} 个会话`),
          React.createElement("div", { style: { display: "flex", gap: "8px" } },
            React.createElement("button", { style: style.btnGhost, onClick: onClose }, "取消"),
            React.createElement("button", { style: style.btn, disabled: busy || selectedCount === 0, onClick: doImport },
              busy ? "导入中…" : `导入 ${selectedCount} 个`))));
    }

    /** 侧边栏入口按钮 */
    function ImportButton() {
      const colors = themeColors()
      const style = makeStyles(colors)
      const [open, setOpen] = useState(false);
      const btnStyle = {
        display: "flex", alignItems: "center", gap: "6px", width: "100%",
        background: "transparent", border: "none", color: "#9aa3b2",
        cursor: "pointer", padding: "6px 10px", borderRadius: "6px", fontSize: "12.5px",
      };
      return React.createElement(React.Fragment, null,
        React.createElement("button", { style: btnStyle, title: "导入其他工具的会话", onClick: () => setOpen(true) },
          React.createElement("span", { style: { fontSize: "14px" } }, "⇩"),
          "导入会话"),
        open && React.createElement(ImportDialog, { onClose: () => setOpen(false) }));
    }

    const name = "dsh-plugin-session-import";
    const inject = ["slots", "locale"];

    function apply(ctx) {
      ctx.slots.inject("sidebar.footer.action", () =>
        ctx.slots.register(
          { name: "sidebar.footer.action", id: "session-import", order: 0, locale: "session-import" },
          ImportButton,
        ));
    }

    module.exports = { name, inject, apply };
    return module.exports;
  },
});
