import * as SelectPrimitive from "@radix-ui/react-select";
import { forwardRef } from "react";
import type { ComponentPropsWithoutRef, ElementRef } from "react";

/**
 * Radix Select for the desktop shell — the same API as the web app's copy, but
 * styled through styles.css instead of Tailwind, since this app has no utility
 * layer.
 *
 * The reason the shell wanted this at all: a native <select> renders its list
 * through the OS, so the dropdown never picked up the window's own surface or
 * the `color-scheme: light dark` the rest of the app is drawn against. Radix
 * renders the list as DOM we control, so it finally matches.
 *
 * Two constraints carry over from the migration:
 *
 *  - A SelectItem may not have `value=""`. Radix reserves the empty string for
 *    "nothing selected", so a blank prompt entry ("Choose a workspace…") must
 *    become SelectValue's `placeholder` rather than an item.
 *  - The content is portaled to <body>, outside every component's styling
 *    context. That is why `.pz-select-content` paints an explicit `Canvas`
 *    background instead of the `transparent` the inline controls use — a
 *    transparent popover over the window would be unreadable.
 */

export const Select = SelectPrimitive.Root;
export const SelectGroup = SelectPrimitive.Group;
export const SelectValue = SelectPrimitive.Value;

export const SelectTrigger = forwardRef<
  ElementRef<typeof SelectPrimitive.Trigger>,
  ComponentPropsWithoutRef<typeof SelectPrimitive.Trigger>
>(function SelectTrigger({ className, children, ...props }, ref) {
  return (
    <SelectPrimitive.Trigger
      ref={ref}
      className={className ? `pz-select-trigger ${className}` : "pz-select-trigger"}
      {...props}
    >
      {children}
      <SelectPrimitive.Icon asChild>
        <ChevronDownIcon />
      </SelectPrimitive.Icon>
    </SelectPrimitive.Trigger>
  );
});

export const SelectContent = forwardRef<
  ElementRef<typeof SelectPrimitive.Content>,
  ComponentPropsWithoutRef<typeof SelectPrimitive.Content>
>(function SelectContent({ className, children, position = "popper", ...props }, ref) {
  return (
    <SelectPrimitive.Portal>
      <SelectPrimitive.Content
        ref={ref}
        position={position}
        sideOffset={4}
        className={className ? `pz-select-content ${className}` : "pz-select-content"}
        {...props}
      >
        <SelectPrimitive.ScrollUpButton className="pz-select-scroll">
          <ChevronUpIcon />
        </SelectPrimitive.ScrollUpButton>
        <SelectPrimitive.Viewport className="pz-select-viewport">{children}</SelectPrimitive.Viewport>
        <SelectPrimitive.ScrollDownButton className="pz-select-scroll">
          <ChevronDownIcon />
        </SelectPrimitive.ScrollDownButton>
      </SelectPrimitive.Content>
    </SelectPrimitive.Portal>
  );
});

export const SelectItem = forwardRef<
  ElementRef<typeof SelectPrimitive.Item>,
  ComponentPropsWithoutRef<typeof SelectPrimitive.Item>
>(function SelectItem({ className, children, ...props }, ref) {
  return (
    <SelectPrimitive.Item
      ref={ref}
      className={className ? `pz-select-item ${className}` : "pz-select-item"}
      {...props}
    >
      <span className="pz-select-indicator">
        <SelectPrimitive.ItemIndicator>
          <CheckIcon />
        </SelectPrimitive.ItemIndicator>
      </span>
      <SelectPrimitive.ItemText>{children}</SelectPrimitive.ItemText>
    </SelectPrimitive.Item>
  );
});

function ChevronDownIcon() {
  return (
    <svg
      aria-hidden="true"
      viewBox="0 0 16 16"
      className="pz-select-chevron"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M4 6l4 4 4-4" />
    </svg>
  );
}

function ChevronUpIcon() {
  return (
    <svg
      aria-hidden="true"
      viewBox="0 0 16 16"
      className="pz-select-chevron"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M12 10L8 6l-4 4" />
    </svg>
  );
}

function CheckIcon() {
  return (
    <svg
      aria-hidden="true"
      viewBox="0 0 16 16"
      className="pz-select-check"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M13 4.5L6.5 11 3 7.5" />
    </svg>
  );
}
