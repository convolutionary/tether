//! Serial consoles (routers, switches, microcontrollers): /dev/ttyUSB0, COM3, …

use std::io::{Read, Write};
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;

use anyhow::{Context, Result};
use parking_lot::Mutex;
use serde::Serialize;
use serialport::{DataBits, FlowControl, Parity, SerialPort, StopBits};

use crate::model::Session;

pub struct Serial {
    port: Mutex<Box<dyn SerialPort>>,
    stop: Arc<AtomicBool>,
}

impl Serial {
    pub fn open(
        s: &Session,
        on_output: impl Fn(&[u8]) + Send + 'static,
        on_exit: impl FnOnce(String) + Send + 'static,
    ) -> Result<Serial> {
        let port = serialport::new(&s.device, s.baud)
            .data_bits(match s.data_bits {
                5 => DataBits::Five,
                6 => DataBits::Six,
                7 => DataBits::Seven,
                _ => DataBits::Eight,
            })
            .parity(match s.parity.as_str() {
                "odd" => Parity::Odd,
                "even" => Parity::Even,
                _ => Parity::None,
            })
            .stop_bits(if s.stop_bits == 2 { StopBits::Two } else { StopBits::One })
            .flow_control(match s.flow.as_str() {
                "hardware" | "rts/cts" => FlowControl::Hardware,
                "software" | "xon/xoff" => FlowControl::Software,
                _ => FlowControl::None,
            })
            .timeout(Duration::from_millis(100))
            .open()
            .with_context(|| format!("couldn't open {} (is it in use, or do you need to be in the dialout group?)", s.device))?;
        let mut reader = port.try_clone()?;
        let stop = Arc::new(AtomicBool::new(false));
        let stop2 = stop.clone();
        std::thread::Builder::new().name("serial-read".into()).spawn(move || {
            let mut buf = [0u8; 4096];
            let reason = loop {
                if stop2.load(Ordering::Relaxed) {
                    break String::new();
                }
                match reader.read(&mut buf) {
                    Ok(0) => {}
                    Ok(n) => on_output(&buf[..n]),
                    Err(e) if e.kind() == std::io::ErrorKind::TimedOut => {}
                    Err(e) => break e.to_string(),
                }
            };
            on_exit(reason);
        })?;
        Ok(Serial { port: Mutex::new(port), stop })
    }

    pub fn write(&self, data: &[u8]) {
        let mut p = self.port.lock();
        let _ = p.write_all(data);
        let _ = p.flush();
    }

    pub fn close(&self) {
        self.stop.store(true, Ordering::Relaxed);
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PortInfo {
    pub name: String,
    pub description: String,
}

pub fn ports() -> Vec<PortInfo> {
    serialport::available_ports()
        .unwrap_or_default()
        .into_iter()
        .map(|p| {
            let description = match p.port_type {
                serialport::SerialPortType::UsbPort(u) => {
                    [u.manufacturer, u.product].into_iter().flatten().collect::<Vec<_>>().join(" ")
                }
                serialport::SerialPortType::PciPort => "PCI".into(),
                serialport::SerialPortType::BluetoothPort => "Bluetooth".into(),
                serialport::SerialPortType::Unknown => String::new(),
            };
            PortInfo { name: p.port_name, description }
        })
        .collect()
}
