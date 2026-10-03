import { useEffect, useState } from "react";
import type { Chat, ChatFolder } from "../../../../server/src/types.ts";
import { api } from "../../lib/api.ts";
import { useWs, useWsReconnect } from "../../lib/ws.ts";

/** A project's chats, live. null until the first load answers. */
export function useChats(projectId: string): Chat[] | null {
  const [chats, setChats] = useState<Chat[] | null>(null);
  useEffect(() => {
    setChats(null);
    void api.chats(projectId).then(setChats, () => setChats([]));
  }, [projectId]);
  // A reply that finished while the socket was down would otherwise show as "thinking…" for ever.
  useWsReconnect(() => void api.chats(projectId).then(setChats, () => {}));
  useWs((m) => {
    if (m.type === "chat.updated" && m.chat.project_id === projectId) {
      setChats((prev) => {
        const list = prev ?? [];
        const rest = list.filter((c) => c.id !== m.chat.id);
        return [m.chat, ...rest].sort((a, b) => b.updated_at.localeCompare(a.updated_at));
      });
    } else if (m.type === "chat.deleted" && m.project_id === projectId) {
      setChats((prev) => prev?.filter((c) => c.id !== m.id) ?? prev);
    }
  });
  return chats;
}

/** A project's chat folders (the Studio's left pane), live: the server sends the whole list on every change. */
export function useChatFolders(projectId: string): ChatFolder[] {
  const [folders, setFolders] = useState<ChatFolder[]>([]);
  useEffect(() => {
    setFolders([]);
    void api.chatFolders(projectId).then(setFolders, () => {});
  }, [projectId]);
  useWsReconnect(() => void api.chatFolders(projectId).then(setFolders, () => {}));
  useWs((m) => {
    if (m.type === "chat.folders" && m.project_id === projectId) setFolders(m.folders);
  });
  return folders;
}
