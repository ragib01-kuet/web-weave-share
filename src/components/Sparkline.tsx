import { useState, useEffect } from 'react';

interface SparklineProps {
  baseValue: number;
  width?: number;
  height?: number;
}

const Sparkline = ({ baseValue, width = 80, height = 24 }: SparklineProps) => {
  const [points, setPoints] = useState<number[]>(() =>
    Array.from({ length: 20 }, () => baseValue * (0.5 + Math.random()))
  );

  useEffect(() => {
    const interval = setInterval(() => {
      setPoints(prev => {
        const next = [...prev.slice(1), baseValue * (0.3 + Math.random() * 1.4)];
        return next;
      });
    }, 800);
    return () => clearInterval(interval);
  }, [baseValue]);

  const max = Math.max(...points, 0.1);
  const pathData = points
    .map((v, i) => {
      const x = (i / (points.length - 1)) * width;
      const y = height - (v / max) * (height - 2);
      return `${i === 0 ? 'M' : 'L'} ${x} ${y}`;
    })
    .join(' ');

  return (
    <svg width={width} height={height} className="overflow-visible">
      <path d={pathData} fill="none" stroke="hsl(var(--primary))" strokeWidth="1.5" strokeLinecap="round" />
    </svg>
  );
};

export default Sparkline;
