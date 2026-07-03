"use client";

import { MessageSquarePlus } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useSessionLayout } from "../../session-layout-context";

export default function ChatNotFound() {
  const { createChat, switchChat } = useSessionLayout();

  const handleCreateChat = () => {
    const { chat } = createChat();
    switchChat(chat.id);
  };

  return (
    <div className="flex h-full flex-col items-center justify-center gap-4 p-8">
      <div className="flex flex-col items-center gap-2 text-center">
        <MessageSquarePlus className="h-10 w-10 text-muted-foreground/50" />
        <h2 className="text-lg font-medium">Chat not found</h2>
        <p className="max-w-sm text-sm text-muted-foreground">
          This chat may have been deleted or doesn&apos;t exist. Start a new one
          to continue working.
        </p>
      </div>
      <Button onClick={handleCreateChat}>
        <MessageSquarePlus className="mr-2 h-4 w-4" />
        New Chat
      </Button>
    </div>
  );
}
