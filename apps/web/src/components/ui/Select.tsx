"use client";

import * as SelectPrimitive from "@radix-ui/react-select";
import { forwardRef } from "react";
import type { ComponentPropsWithoutRef, ElementRef } from "react";

/**
 * Radix Select, wrapped once so every picker in the web app shares one trigger
 * and one popover. The native <select> this replaces handed its dropdown to the
 * OS, which meant the list could never match the app's own surface — different
 * font, different rounding, no styling hook at all. Radix renders the list as
 * real DOM we own, at the cost of having to supply the keyboard and focus
 * behaviour the platform used to give us for free (that part is Radix's job).
 *
 * Two rules carry over from the migration and are easy to trip on later:
 *
 *  - A SelectItem may not have `value=""` — Radix reserves the empty string for
 *    "nothing is selected" and throws if an item claims it. A picker whose blank
 *    entry is only a prompt ("Select…") should drop the entry and pass
 *    `placeholder` to SelectValue instead. A picker where blank is a real,
 *    choosable state (TaskBoard's "Unassigned") needs a sentinel value mapped
 *    back to "" at the callback boundary.
 *  - Sizing lives in the `size` prop, not in `className`. Tailwind has no
 *    conflict resolution here, so a caller passing `px-1.5` alongside the base
 *    `px-3` would win or lose depending on stylesheet order. `className` is for
 *    layout only (width, margin).
 */

const SIZES = {
  md: "h-9 px-3 text-sm",
  sm: "h-6 px-2 text-[10px]",
} as const;

export type SelectSize = keyof typeof SIZES;

export const Select = SelectPrimitive.Root;
export const SelectGroup = SelectPrimitive.Group;
export const SelectValue = SelectPrimitive.Value;

export const SelectTrigger = forwardRef<
  ElementRef<typeof SelectPrimitive.Trigger>,
  ComponentPropsWithoutRef<typeof SelectPrimitive.Trigger> & { size?: SelectSize }
>(function SelectTrigger({ className = "", size = "md", children, ...props }, ref) {
  return (
    <SelectPrimitive.Trigger
      ref={ref}
      className={[
        "inline-flex items-center justify-between gap-2 rounded-lg border border-slate-300 bg-white",
        "text-slate-700 shadow-sm outline-none transition-colors",
        "hover:border-slate-400 focus:border-slate-500 focus:ring-2 focus:ring-slate-200",
        "disabled:cursor-not-allowed disabled:bg-slate-50 disabled:opacity-60",
        "data-[placeholder]:text-slate-400",
        SIZES[size],
        className,
      ].join(" ")}
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
>(function SelectContent({ className = "", children, position = "popper", ...props }, ref) {
  return (
    <SelectPrimitive.Portal>
      <SelectPrimitive.Content
        ref={ref}
        position={position}
        sideOffset={4}
        className={[
          "z-50 max-h-72 overflow-hidden rounded-lg border border-slate-200 bg-white text-slate-700 shadow-lg",
          // Without a floor the popover collapses to its longest item, which
          // reads as a different control than the trigger it dropped out of.
          position === "popper" ? "min-w-[var(--radix-select-trigger-width)]" : "",
          className,
        ].join(" ")}
        {...props}
      >
        <SelectPrimitive.ScrollUpButton className="flex h-6 items-center justify-center text-slate-400">
          <ChevronUpIcon />
        </SelectPrimitive.ScrollUpButton>
        <SelectPrimitive.Viewport className="p-1">{children}</SelectPrimitive.Viewport>
        <SelectPrimitive.ScrollDownButton className="flex h-6 items-center justify-center text-slate-400">
          <ChevronDownIcon />
        </SelectPrimitive.ScrollDownButton>
      </SelectPrimitive.Content>
    </SelectPrimitive.Portal>
  );
});

export const SelectItem = forwardRef<
  ElementRef<typeof SelectPrimitive.Item>,
  ComponentPropsWithoutRef<typeof SelectPrimitive.Item>
>(function SelectItem({ className = "", children, ...props }, ref) {
  return (
    <SelectPrimitive.Item
      ref={ref}
      className={[
        "relative flex cursor-default select-none items-center rounded-md py-1.5 pl-7 pr-2 text-sm outline-none",
        "data-[highlighted]:bg-slate-100 data-[highlighted]:text-slate-900",
        "data-[disabled]:pointer-events-none data-[disabled]:opacity-50",
        className,
      ].join(" ")}
      {...props}
    >
      <span className="absolute left-2 flex h-3.5 w-3.5 items-center justify-center">
        <SelectPrimitive.ItemIndicator>
          <CheckIcon />
        </SelectPrimitive.ItemIndicator>
      </span>
      <SelectPrimitive.ItemText>{children}</SelectPrimitive.ItemText>
    </SelectPrimitive.Item>
  );
});

export const SelectSeparator = forwardRef<
  ElementRef<typeof SelectPrimitive.Separator>,
  ComponentPropsWithoutRef<typeof SelectPrimitive.Separator>
>(function SelectSeparator({ className = "", ...props }, ref) {
  return (
    <SelectPrimitive.Separator
      ref={ref}
      className={["-mx-1 my-1 h-px bg-slate-200", className].join(" ")}
      {...props}
    />
  );
});

export const SelectLabel = forwardRef<
  ElementRef<typeof SelectPrimitive.Label>,
  ComponentPropsWithoutRef<typeof SelectPrimitive.Label>
>(function SelectLabel({ className = "", ...props }, ref) {
  return (
    <SelectPrimitive.Label
      ref={ref}
      className={["px-2 py-1.5 text-xs font-medium text-slate-500", className].join(" ")}
      {...props}
    />
  );
});

function ChevronDownIcon() {
  return (
    <svg
      aria-hidden="true"
      viewBox="0 0 16 16"
      className="h-3.5 w-3.5 shrink-0 opacity-60"
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
      className="h-3.5 w-3.5 shrink-0 opacity-60"
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
      className="h-3.5 w-3.5"
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
