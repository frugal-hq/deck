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

export function buildTree(chats, keyOf, workspaces = {}) {
  const byName = new Map();
  const workspace = (name) => {
    if (!byName.has(name)) byName.set(name, { name, groups: [], chats: [], keys: new Set() });
    return byName.get(name);
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
  return {
    workspaces: [...byName.values()].map(({ name, groups, chats }) => ({ name, groups, chats })),
    groups: top,
  };
}
