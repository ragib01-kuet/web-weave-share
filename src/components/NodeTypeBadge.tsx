interface Props {
  type: 'gateway' | 'relay' | 'client';
  className?: string;
}

const config: Record<string, { label: string; colorClass: string; dotClass: string }> = {
  gateway: { label: 'GATEWAY', colorClass: 'text-primary', dotClass: 'bg-primary signal-glow' },
  relay: { label: 'RELAY', colorClass: 'text-[hsl(280,70%,60%)]', dotClass: 'bg-[hsl(280,70%,60%)]' },
  client: { label: 'CLIENT', colorClass: 'text-accent', dotClass: 'bg-accent mesh-glow' },
};

const NodeTypeBadge = ({ type, className = '' }: Props) => {
  const c = config[type];
  return (
    <div className={`flex items-center gap-1.5 ${className}`}>
      <div className={`h-2 w-2 rounded-full ${c.dotClass}`} />
      <span className={`text-[10px] font-mono tracking-wider ${c.colorClass}`}>{c.label}</span>
    </div>
  );
};

export default NodeTypeBadge;
