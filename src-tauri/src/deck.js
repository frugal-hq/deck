// window.deck for the Tauri build: the methods of src/main/preload.js, so the renderer does not change.
// Channel 'group:name-part' is the command group_name_part, its arguments go by their preload names, and an
// event's payload is the array of arguments Electron passed to the callback.
(() => {
  const command = (channel) => channel.replace(/[:-]/g, '_');
  const invoke = (channel, args) => window.__TAURI__.core.invoke(command(channel), args);
  const send = (channel, args) => {
    invoke(channel, args).catch((error) => console.warn(channel, error));
  };
  const on = (channel, callback) => {
    window.__TAURI__.event.listen(channel, (event) => callback(...event.payload));
  };
  // A chat's output and exit come on its own channel, in order: a string is output, {exit} the exit code.
  const dataCallbacks = [];
  const exitCallbacks = [];
  const output = (id) => {
    const channel = new window.__TAURI__.core.Channel();
    channel.onmessage = (message) => {
      if (typeof message === 'string') for (const callback of dataCallbacks) callback(id, message);
      else for (const callback of exitCallbacks) callback(id, message.exit);
    };
    return channel;
  };

  window.deck = {
    pickFolder: () => invoke('folder:pick'),
    pickFiles: () => invoke('files:pick'),
    // frugal: File objects carry no path in WebView2; phase 6 maps window drop events to paths.
    pathForFile: () => '',
    thumbnail: (file) => invoke('files:thumbnail', { file }),
    savePasted: (bytes, type) => invoke('files:save-pasted', { bytes, type }),
    defaultFolder: () => invoke('folder:default'),
    estimateTopics: (options) => invoke('topics:estimate', { options }),
    runTopics: (options) => invoke('topics:run', { options }),
    restoreTitles: () => send('topics:restore-titles'),
    onTopicsProgress: (callback) => on('topics:progress', callback),
    start: (options) => invoke('chat:start', { options, output: output(options.id) }),
    subagents: (id, cwd) => invoke('chat:subagents', { id, cwd }),
    input: (id, data) => send('chat:input', { id, data }),
    resize: (id, cols, rows) => send('chat:resize', { id, cols, rows }),
    kill: (id) => send('chat:kill', { id }),
    onData: (callback) => dataCallbacks.push(callback),
    onEdit: (callback) => on('chat:edit', callback),
    saveEdit: (id, text) => send('chat:save-edit', { id, text }),
    onExit: (callback) => exitCallbacks.push(callback),
    onMeters: (callback) => on('chat:meters', callback),
    onRestarting: (callback) => on('chat:restarting', callback),
    onTurnEnd: (callback) => on('chat:turn-end', callback),
    onHandoff: (callback) => on('chat:handoff', callback),
    continueIn: (options) => invoke('chat:continue', { options }),
    switchAccount: (options) => invoke('chat:switch-account', { options }),
    setVoiceMode: (mode) => send('voice:mode', { mode }),
    voiceStatus: (model) => invoke('voice:status', { model }),
    voicePrepare: (model) => invoke('voice:prepare', { model }),
    voiceTranscribe: (options) => invoke('voice:transcribe', { options: { ...options, audio: options?.audio instanceof ArrayBuffer ? Array.from(new Uint8Array(options.audio)) : options?.audio } }),
    onVoiceProgress: (callback) => on('voice:progress', callback),
    setAttention: (count) => send('window:attention', { count }),
    login: (options) => invoke('accounts:login', { options }),
    logout: (id) => invoke('accounts:logout', { id }),
    removeAccount: (id) => invoke('accounts:remove', { id }),
    setPrimary: (id) => invoke('accounts:set-primary', { id }),
    getAccounts: () => invoke('accounts:get'),
    mcpList: (scope, accountId) => invoke('mcp:list', { scope, accountId }),
    mcpSet: (scope, names) => invoke('mcp:set', { scope, names }),
    getRoles: () => invoke('settings:roles'),
    setRoles: (on) => send('settings:set-roles', { on }),
    renameAccount: (id, name) => invoke('accounts:rename', { id, name }),
    setAccountCap: (id, field, value) => invoke('accounts:set-cap', { id, field, value }),
    refreshAccounts: () => invoke('accounts:refresh'),
    onAccounts: (callback) => on('accounts:changed', callback),
    getSessions: () => invoke('sessions:get'),
    getAllSessions: () => invoke('sessions:all'),
    organize: (id, organization) => send('sessions:organize', { id, organization }),
    setGroup: (id, name) => send('sessions:set-group', { id, name }),
    setWorkspace: (group, workspace) => send('sessions:set-workspace', { group, workspace }),
    setWorkspaceParent: (name, parent) => send('workspaces:set-parent', { name, parent }),
    renameWorkspace: (from, to) => send('workspaces:rename', { from, to }),
    deleteWorkspace: (name) => send('workspaces:delete', { name }),
    renameGroup: (ids, from, to) => send('groups:rename', { ids, from, to }),
    deleteGroup: (ids, group) => send('groups:delete', { ids, group }),
    clearWorkspaces: () => send('workspaces:clear'),
    estimateWorkspaces: () => invoke('workspaces:estimate'),
    runWorkspaces: (options) => invoke('workspaces:run', { options }),
    link: (id, parentId) => send('sessions:link', { id, parentId }),
    undoLink: () => send('sessions:undo-link'),
    estimateJoins: () => invoke('joins:estimate'),
    runJoins: (options) => invoke('joins:run', { options }),
    clearJoins: () => send('joins:clear'),
    onSessions: (callback) => on('sessions:changed', callback),
    openLink: (url, cwd) => send('link:open', { url, cwd }),
    windowAction: (action) => send('window:action', { action }),
    onMaximized: (callback) => on('window:maximized', callback),
  };
})();
