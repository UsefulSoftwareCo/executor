"use client";

import {
  useState,
  useCallback,
  useMemo,
  useEffect,
  type ReactNode,
} from "react";
import { Check, X } from "lucide-react";
import { cn } from "@/lib/utils";
import type { AskUserQuestionInput } from "@/lib/chat/tool-contracts";

type InlineQuestionAnswer = {
  optionId?: string;
  text?: string;
};

type UseInlineQuestionOptions = {
  question: AskUserQuestionInput | null;
  onSubmit: (answer: InlineQuestionAnswer) => void;
  onCancel: () => void;
  textareaValue: string;
  onTextareaChange: (value: string) => void;
};

type QuestionState = {
  selectedOptionId: string | null;
};

export function useInlineQuestion({
  question,
  onSubmit,
  onCancel,
  textareaValue,
  onTextareaChange,
}: UseInlineQuestionOptions) {
  const [state, setState] = useState<QuestionState>(() => ({
    selectedOptionId: null,
  }));

  const isActive = question !== null;
  const options = question?.options ?? [];

  const selectOption = useCallback(
    (optionId: string) => {
      setState({ selectedOptionId: optionId });
      onTextareaChange("");
    },
    [onTextareaChange],
  );

  const hasCurrentAnswer = useMemo(() => {
    if (!question) return false;
    const customText = question.allowFreeform === false ? "" : textareaValue.trim();
    if (customText) return true;
    return state.selectedOptionId !== null;
  }, [question, textareaValue, state.selectedOptionId]);

  const handleNext = useCallback(() => {
    if (!question) return;

    const customText = question.allowFreeform === false ? "" : textareaValue.trim();
    if (customText) {
      onSubmit({ text: customText });
      onTextareaChange("");
      return;
    }

    if (state.selectedOptionId) {
      onSubmit({ optionId: state.selectedOptionId });
    }
  }, [
    question,
    textareaValue,
    state.selectedOptionId,
    onSubmit,
    onTextareaChange,
  ]);

  const buttonLabel = "Submit answer";
  const compactButtonLabel = "Submit";

  const placeholder =
    question?.allowFreeform === false
      ? "Choose an option"
      : "Type your answer, or leave blank to use the selected option";

  // Escape to cancel (only when active)
  useEffect(() => {
    if (!isActive) return;
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        onCancel();
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [isActive, onCancel]);

  useEffect(() => {
    if (question) {
      setState({ selectedOptionId: null });
    }
  }, [question?.prompt]);

  const questionHeaderUI: ReactNode = question ? (
    <div className="space-y-2.5 px-4 pt-3">
      <div className="flex items-start justify-between gap-3">
        <div className="flex min-w-0 flex-1 flex-wrap items-baseline gap-x-2 gap-y-1">
          <span className="shrink-0 font-mono text-xs font-medium text-muted-foreground">
            ?
          </span>
          <span className="shrink-0 font-mono text-[10px] font-semibold uppercase tracking-[0.15em] text-muted-foreground/70">
            Agent question
          </span>
          <span className="text-sm text-foreground">{question.prompt}</span>
        </div>
        <button
          type="button"
          onClick={onCancel}
          className="shrink-0 rounded-md p-1 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
        >
          <X className="h-3.5 w-3.5" />
        </button>
      </div>

      <div className="flex flex-wrap gap-1.5">
        {options.map((option) => {
          const isSelected = state.selectedOptionId === option.id;

          return (
            <button
              key={option.id}
              type="button"
              onClick={() => selectOption(option.id)}
              title={option.description || undefined}
              className={cn(
                "flex items-center gap-1.5 rounded-lg border px-3 py-1.5 text-sm transition-all",
                isSelected
                  ? "border-primary bg-primary/10 font-medium text-primary"
                  : "border-border bg-background text-foreground hover:border-primary/50 hover:bg-accent",
              )}
            >
              {isSelected && <Check className="h-3 w-3" />}
              {option.label}
            </button>
          );
        })}
      </div>
    </div>
  ) : null;

  return {
    isActive,
    questionHeaderUI: isActive ? questionHeaderUI : null,
    handleNext,
    hasCurrentAnswer,
    buttonLabel,
    compactButtonLabel,
    placeholder,
  };
}
