export function groupChats(sessions) {
  const grouped = Map.groupBy(sessions, (session) => session.chatId);
  return [...grouped.values()].map((list) => {
    const head = list[0];
    const spaces = list.map((session) => session.space).filter((space) => space != null);
    const topics = list.map((session) => session.topic).filter((topic) => topic != null);
    const userGroup = list.find((session) => session.userGroup != null)?.userGroup ?? null;
    const tags = [];
    for (const session of list) {
      for (const tag of session.tags ?? []) {
        if (!tags.includes(tag)) tags.push(tag);
      }
    }
    return {
      ...head,
      pinned: list.some((session) => session.pinned),
      space: head.space ?? (spaces.length ? spaces[0] : null),
      tags,
      topic: userGroup ?? head.topic ?? (topics.length ? topics[0] : null),
      userGroup,
      earlier: list.slice(1),
    };
  });
}

// parents maps a workspace to the workspace that holds it; names match in any case, and a loop leaves its workspaces on top.
export function buildTree(chats, keyOf, workspaces = {}, parents = {}) {
  const byName = new Map();
  const workspace = (name) => {
    const found = byName.get(name.toLowerCase());
    if (found) return found;
    const created = { name, groups: [], chats: [], spaces: [], keys: new Set() };
    byName.set(name.toLowerCase(), created);
    return created;
  };
  const groups = new Map();
  const top = [];
  for (const chat of chats) {
    if (chat.space != null) {
      workspace(chat.space).chats.push(chat);
      continue;
    }
    const key = keyOf(chat);
    let list = groups.get(key);
    if (!list) {
      list = [];
      groups.set(key, list);
      const target = workspaces[key];
      if (target != null && target !== '') {
        const parent = workspace(target);
        if (!parent.keys.has(key)) {
          parent.keys.add(key);
          parent.groups.push([key, list]);
        }
      } else {
        top.push([key, list]);
      }
    }
    list.push(chat);
  }
  const parentOf = new Map(Object.entries(parents).filter(([, parent]) => parent).map(([name, parent]) => [name.toLowerCase(), parent]));
  const loops = (name) => {
    const seen = new Set();
    for (let at = name.toLowerCase(); parentOf.has(at); at = parentOf.get(at).toLowerCase()) {
      if (seen.has(at)) return true;
      seen.add(at);
    }
    return false;
  };
  const nested = new Set();
  const pending = [...byName.values()];
  while (pending.length) {
    const child = pending.pop();
    const parentName = parentOf.get(child.name.toLowerCase());
    if (!parentName || nested.has(child) || loops(child.name)) continue;
    const isNew = !byName.has(parentName.toLowerCase());
    const parent = workspace(parentName);
    if (isNew) pending.push(parent);
    parent.spaces.push(child);
    nested.add(child);
  }
  const out = ({ name, groups, chats: own, spaces }) => ({ name, groups, chats: own, spaces: spaces.map(out) });
  return {
    workspaces: [...byName.values()].filter((space) => !nested.has(space)).map(out),
    groups: top,
  };
}
