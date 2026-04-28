interface HelpTipProps {
    content: string;
    position?: 'top' | 'bottom' | 'left' | 'right';
    maxWidth?: number;
    /** Size variant: 'sm' (default) or 'xs' for tighter spaces */
    size?: 'sm' | 'xs';
}
/**
 * Small "?" icon that reveals a tooltip on hover.
 * Place next to labels, headers or buttons that need explanation.
 */
export default function HelpTip({ content, position, maxWidth, size, }: HelpTipProps): import("react/jsx-runtime").JSX.Element;
export {};
//# sourceMappingURL=HelpTip.d.ts.map