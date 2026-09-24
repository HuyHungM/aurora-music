import type { SVGProps } from "react";

export interface IconProps extends SVGProps<SVGSVGElement> {
  size?: number;
}

function base({ size, ...props }: IconProps) {
  return {
    width: size ?? 20,
    height: size ?? 20,
    viewBox: "0 0 24 24",
    fill: "none",
    stroke: "currentColor",
    strokeWidth: 1.8,
    strokeLinecap: "round" as const,
    strokeLinejoin: "round" as const,
    "aria-hidden": true,
    ...props,
  };
}

export function HomeIcon(props: IconProps) {
  return (
    <svg {...base(props)}>
      <path d="M3 10.5 12 3l9 7.5" />
      <path d="M5 9.5V21h5v-6h4v6h5V9.5" />
    </svg>
  );
}

export function SearchIcon(props: IconProps) {
  return (
    <svg {...base(props)}>
      <circle cx="11" cy="11" r="7" />
      <path d="m20 20-3.2-3.2" />
    </svg>
  );
}

export function LibraryIcon(props: IconProps) {
  return (
    <svg {...base(props)}>
      <path d="M4 4.5v15" />
      <path d="M8 4.5v15" />
      <path d="M13 5.5 18.5 3l2.5 14.5-5 2.5L13 5.5Z" />
    </svg>
  );
}

export function RadioIcon(props: IconProps) {
  return (
    <svg {...base(props)}>
      <circle cx="12" cy="12" r="2" />
      <path d="M5 6.5a10 10 0 0 0 0 11" />
      <path d="M19 6.5a10 10 0 0 1 0 11" />
      <path d="M8 9.5a6 6 0 0 0 0 5" />
      <path d="M16 9.5a6 6 0 0 1 0 5" />
    </svg>
  );
}

export function UserIcon(props: IconProps) {
  return (
    <svg {...base(props)}>
      <circle cx="12" cy="8" r="4" />
      <path d="M4 20c0-3.5 3.6-5 8-5s8 1.5 8 5" />
    </svg>
  );
}

export function HeartIcon(props: IconProps) {
  return (
    <svg {...base(props)}>
      <path d="M12 20.5C6 16 3 12.5 3 8.8 3 6 5.2 4 7.8 4c1.7 0 3.2.8 4.2 2.2C13 4.8 14.5 4 16.2 4 18.8 4 21 6 21 8.8c0 3.7-3 7.2-9 11.7Z" />
    </svg>
  );
}

export function ClockIcon(props: IconProps) {
  return (
    <svg {...base(props)}>
      <circle cx="12" cy="12" r="8.5" />
      <path d="M12 7.5V12l3 2" />
    </svg>
  );
}

export function MusicNoteIcon(props: IconProps) {
  return (
    <svg {...base(props)}>
      <path d="M9 18V5.5l10-2V16" />
      <circle cx="6.5" cy="18" r="2.5" />
      <circle cx="16.5" cy="16" r="2.5" />
    </svg>
  );
}

export function MenuIcon(props: IconProps) {
  return (
    <svg {...base(props)}>
      <path d="M4 7h16" />
      <path d="M4 12h16" />
      <path d="M4 17h16" />
    </svg>
  );
}

export function XIcon(props: IconProps) {
  return (
    <svg {...base(props)}>
      <path d="m6 6 12 12" />
      <path d="m18 6-12 12" />
    </svg>
  );
}

export function PlusIcon(props: IconProps) {
  return (
    <svg {...base(props)}>
      <path d="M12 5v14" />
      <path d="M5 12h14" />
    </svg>
  );
}

export function ChevronRightIcon(props: IconProps) {
  return (
    <svg {...base(props)}>
      <path d="m9 6 6 6-6 6" />
    </svg>
  );
}

export function LogOutIcon(props: IconProps) {
  return (
    <svg {...base(props)}>
      <path d="M9 21H5a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1h4" />
      <path d="m16 17 5-5-5-5" />
      <path d="M21 12H9" />
    </svg>
  );
}

export function SparkleIcon(props: IconProps) {
  return (
    <svg {...base(props)}>
      <path d="M12 3v6" />
      <path d="M12 15v6" />
      <path d="M3 12h6" />
      <path d="M15 12h6" />
      <path d="M5.6 5.6l4.2 4.2" />
      <path d="M14.2 14.2l4.2 4.2" />
      <path d="M18.4 5.6l-4.2 4.2" />
      <path d="M9.8 14.2l-4.2 4.2" />
    </svg>
  );
}

export function PlayIcon(props: IconProps) {
  return (
    <svg {...base(props)} fill="currentColor" stroke="none">
      <path d="M8 5.5v13l11-6.5L8 5.5Z" />
    </svg>
  );
}

export function PauseIcon(props: IconProps) {
  return (
    <svg {...base(props)} fill="currentColor" stroke="none">
      <path d="M7 5h3.2v14H7zM13.8 5H17v14h-3.2z" />
    </svg>
  );
}

export function SkipBackIcon(props: IconProps) {
  return (
    <svg {...base(props)} fill="currentColor" stroke="none">
      <path d="M17.5 5.5v13L7 12l10.5-6.5Z" />
      <path d="M6 5v14" stroke="currentColor" strokeWidth={2} />
    </svg>
  );
}

export function SkipForwardIcon(props: IconProps) {
  return (
    <svg {...base(props)} fill="currentColor" stroke="none">
      <path d="M6.5 5.5v13L17 12 6.5 5.5Z" />
      <path d="M18 5v14" stroke="currentColor" strokeWidth={2} />
    </svg>
  );
}

export function VolumeIcon(props: IconProps) {
  return (
    <svg {...base(props)}>
      <path d="M4 9v6h4l5 4V5L8 9H4Z" fill="currentColor" stroke="none" />
      <path d="M16 8.5a4.5 4.5 0 0 1 0 7" />
      <path d="M18.5 5.8a8 8 0 0 1 0 12.4" />
    </svg>
  );
}

export function VolumeMuteIcon(props: IconProps) {
  return (
    <svg {...base(props)}>
      <path d="M4 9v6h4l5 4V5L8 9H4Z" fill="currentColor" stroke="none" />
      <path d="m16 9.5 5 5" />
      <path d="m21 9.5-5 5" />
    </svg>
  );
}

export function QueueIcon(props: IconProps) {
  return (
    <svg {...base(props)}>
      <path d="M4 6h16" />
      <path d="M4 12h10" />
      <path d="M4 18h10" />
      <path d="M17 16l3 3-3 3" />
      <path d="M20 19h-5" />
    </svg>
  );
}

export function ShuffleIcon(props: IconProps) {
  return (
    <svg {...base(props)}>
      <path d="M2 18h2.2a2 2 0 0 0 1.7-1l3.6-5.2a2 2 0 0 1 3.4 0L15 17" />
      <path d="M18 18h2.2a2 2 0 0 0 1.7-3l-3.6-5.2a2 2 0 0 1 0-6.6" />
      <path d="m20 2-4 4" />
      <path d="m20 2-4 4" />
      <path d="m16 6 4-4" />
      <path d="m16 6 4-4" />
    </svg>
  );
}

export function RepeatIcon(props: IconProps) {
  return (
    <svg {...base(props)}>
      <path d="M17 2l4 4-4 4" />
      <path d="M3 11v-1a4 4 0 0 1 4-4h14" />
      <path d="M7 22l-4-4 4-4" />
      <path d="M21 13v1a4 4 0 0 1-4 4H3" />
    </svg>
  );
}

export function RepeatOneIcon(props: IconProps) {
  return (
    <svg {...base(props)}>
      <path d="M17 2l4 4-4 4" />
      <path d="M3 11v-1a4 4 0 0 1 4-4h14" />
      <path d="M7 22l-4-4 4-4" />
      <path d="M21 13v1a4 4 0 0 1-4 4H3" />
      <path d="M12 14.5v-5l2 2.5-2 2.5" />
    </svg>
  );
}

export function AlertCircleIcon(props: IconProps) {
  return (
    <svg {...base(props)}>
      <circle cx="12" cy="12" r="10" />
      <line x1="12" y1="8" x2="12" y2="12" />
      <line x1="12" y1="16" x2="12.01" y2="16" />
    </svg>
  );
}

export function CheckIcon(props: IconProps) {
  return (
    <svg {...base(props)}>
      <polyline points="20 6 9 17 4 12" />
    </svg>
  );
}

export function ListMusicIcon(props: IconProps) {
  return (
    <svg {...base(props)}>
      <path d="M21 15V6" />
      <path d="M18.5 18a2.5 2.5 0 1 0 0-5 2.5 2.5 0 0 0 0 5Z" />
      <path d="M12 12H3" />
      <path d="M16 6H3" />
      <path d="M12 18H3" />
    </svg>
  );
}

export function ArrowUpIcon(props: IconProps) {
  return (
    <svg {...base(props)}>
      <path d="m18 15-6-6-6 6" />
    </svg>
  );
}

export function ArrowDownIcon(props: IconProps) {
  return (
    <svg {...base(props)}>
      <path d="m6 9 6 6 6-6" />
    </svg>
  );
}

export function TrashIcon(props: IconProps) {
  return (
    <svg {...base(props)}>
      <path d="M3 6h18" />
      <path d="M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6" />
      <path d="M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2" />
      <line x1="10" y1="11" x2="10" y2="17" />
      <line x1="14" y1="11" x2="14" y2="17" />
    </svg>
  );
}

export function PencilIcon(props: IconProps) {
  return (
    <svg {...base(props)}>
      <path d="M21.174 6.812a1 1 0 0 0-3.986-3.987L3.842 16.174a2 2 0 0 0-.5.83l-1.321 4.352a.5.5 0 0 0 .623.622l4.353-1.32a2 2 0 0 0 .83-.497z" />
      <path d="m15 5 4 4" />
    </svg>
  );
}

export function ExpandIcon(props: IconProps) {
  return (
    <svg {...base(props)}>
      <path d="M15 3h6v6" />
      <path d="M9 21H3v-6" />
      <path d="M21 3l-7 7" />
      <path d="M3 21l7-7" />
    </svg>
  );
}