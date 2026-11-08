//! The strip under an SSH tab: load, CPU, memory, disk and uptime of the server (Linux servers).

use std::time::Duration;

use anyhow::{Result, anyhow};
use serde::Serialize;

use crate::{Core, TermId};

#[derive(Debug, Clone, Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct Stats {
    pub cpus: u32,
    pub load1: f32,
    /// percent busy since the previous sample (None on the first)
    pub cpu: Option<f32>,
    pub mem_total: u64,
    pub mem_used: u64,
    pub disk_total: u64,
    pub disk_used: u64,
    pub uptime: u64,
    #[serde(skip)]
    cpu_sample: Option<(u64, u64)>,
}

const SCRIPT: &str = "cat /proc/loadavg; echo @; grep -E '^(MemTotal|MemAvailable):' /proc/meminfo; echo @; \
df -kP / | tail -n 1; echo @; cat /proc/uptime; echo @; nproc 2>/dev/null || getconf _NPROCESSORS_ONLN; echo @; head -n 1 /proc/stat";

impl Core {
    /// One sample. Pass the previous one back so CPU% can be computed.
    pub async fn stats(&self, term: TermId, prev: Option<(u64, u64)>) -> Result<(Stats, (u64, u64))> {
        let t = self.term(term)?;
        let conn = t.conn().ok_or_else(|| anyhow!("not connected"))?;
        if conn.os.lock().as_str() != "Linux" {
            return Err(anyhow!("stats need a Linux server"));
        }
        let (_, out) = conn.exec(SCRIPT, Duration::from_secs(5)).await?;
        let mut s = parse(&out);
        let sample = s.cpu_sample.take().unwrap_or((0, 0));
        if let Some((pt, pi)) = prev {
            let (dt, di) = (sample.0.saturating_sub(pt), sample.1.saturating_sub(pi));
            if dt > 0 {
                s.cpu = Some(100.0 * (dt - di.min(dt)) as f32 / dt as f32);
            }
        }
        Ok((s, sample))
    }
}

fn parse(out: &str) -> Stats {
    let parts: Vec<&str> = out.split("@\n").collect();
    let mut s = Stats::default();
    if let Some(l) = parts.first() {
        s.load1 = l.split_whitespace().next().and_then(|v| v.parse().ok()).unwrap_or(0.0);
    }
    if let Some(m) = parts.get(1) {
        let kb = |key: &str| {
            m.lines().find(|l| l.starts_with(key)).and_then(|l| l.split_whitespace().nth(1)).and_then(|v| v.parse::<u64>().ok()).unwrap_or(0) * 1024
        };
        s.mem_total = kb("MemTotal:");
        s.mem_used = s.mem_total.saturating_sub(kb("MemAvailable:"));
    }
    if let Some(d) = parts.get(2) {
        let f: Vec<&str> = d.split_whitespace().collect();
        if f.len() >= 4 {
            s.disk_total = f[1].parse::<u64>().unwrap_or(0) * 1024;
            s.disk_used = f[2].parse::<u64>().unwrap_or(0) * 1024;
        }
    }
    if let Some(u) = parts.get(3) {
        s.uptime = u.split_whitespace().next().and_then(|v| v.parse::<f64>().ok()).unwrap_or(0.0) as u64;
    }
    if let Some(n) = parts.get(4) {
        s.cpus = n.trim().parse().unwrap_or(0);
    }
    if let Some(c) = parts.get(5) {
        let nums: Vec<u64> = c.split_whitespace().skip(1).filter_map(|v| v.parse().ok()).collect();
        if nums.len() >= 5 {
            let total: u64 = nums.iter().sum();
            let idle = nums[3] + nums[4];
            s.cpu_sample = Some((total, idle));
        }
    }
    s
}

#[cfg(test)]
mod tests {
    #[test]
    fn parses() {
        let out = "0.52 0.40 0.30 1/200 999\n@\nMemTotal:       16000000 kB\nMemAvailable:    4000000 kB\n@\n/dev/sda1 100000 25000 75000 25% /\n@\n12345.67 1000.0\n@\n8\n@\ncpu  100 0 50 800 50 0 0 0 0 0\n";
        let s = super::parse(out);
        assert_eq!(s.cpus, 8);
        assert!((s.load1 - 0.52).abs() < 0.001);
        assert_eq!(s.mem_used, 12_000_000 * 1024);
        assert_eq!(s.disk_used, 25_000 * 1024);
        assert_eq!(s.uptime, 12345);
        assert_eq!(s.cpu_sample, Some((1000, 850)));
    }
}
