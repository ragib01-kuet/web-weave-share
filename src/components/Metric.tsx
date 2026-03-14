interface MetricProps {
  label: string;
  value: string;
  unit?: string;
}

const Metric = ({ label, value, unit }: MetricProps) => (
  <div className="text-right">
    <div className="text-sm font-mono tabular tracking-tight">
      {value}
      {unit && <span className="text-muted-foreground ml-0.5">{unit}</span>}
    </div>
    <div className="status-label">{label}</div>
  </div>
);

export default Metric;
