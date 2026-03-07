import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { invoke } from '@tauri-apps/api/core';
import type { Conversation, ConversationMessage } from '@mozzie/db';
import { useWorkspaceStore } from '../stores/workspaceStore';

const CONVERSATIONS_KEY = 'conversations';
const CONVERSATION_MESSAGES_KEY = 'conversation-messages';

export function useConversations() {
  const workspaceId = useWorkspaceStore((s) => s.activeWorkspaceId);

  return useQuery({
    queryKey: [CONVERSATIONS_KEY, workspaceId],
    queryFn: () =>
      invoke<Conversation[]>('list_conversations', { workspaceId }),
  });
}

export function useConversationMessages(conversationId: string | null) {
  return useQuery({
    queryKey: [CONVERSATION_MESSAGES_KEY, conversationId],
    queryFn: () =>
      invoke<ConversationMessage[]>('list_conversation_messages', {
        conversationId,
      }),
    enabled: !!conversationId,
  });
}

export function useCreateConversation() {
  const queryClient = useQueryClient();
  const workspaceId = useWorkspaceStore((s) => s.activeWorkspaceId);

  return useMutation({
    mutationFn: (title?: string) =>
      invoke<Conversation>('create_conversation', {
        workspaceId,
        title: title ?? null,
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: [CONVERSATIONS_KEY] });
    },
  });
}

export function useDeleteConversation() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (id: string) =>
      invoke<void>('delete_conversation', { id }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: [CONVERSATIONS_KEY] });
    },
  });
}

export function useAppendMessage() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: ({
      conversationId,
      role,
      text,
      metadata,
    }: {
      conversationId: string;
      role: 'user' | 'orchestrator';
      text: string;
      metadata?: string | null;
    }) =>
      invoke<ConversationMessage>('append_conversation_message', {
        conversationId,
        role,
        text,
        metadata: metadata ?? null,
      }),
    onSuccess: (_data, variables) => {
      queryClient.invalidateQueries({
        queryKey: [CONVERSATION_MESSAGES_KEY, variables.conversationId],
      });
      queryClient.invalidateQueries({
        queryKey: [CONVERSATIONS_KEY],
      });
    },
  });
}
