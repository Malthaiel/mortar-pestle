//! PipeWire stream format negotiation, buffer parsing, and PTS extraction.
//!
//! The pure, mainloop-agnostic half of the capture path — the dmabuf format
//! offer, the `SPA_PARAM_Buffers` declaration, dmabuf/SHM frame parsing, and the
//! `SPA_META_Header` PTS read. Shared by the continuous `capture::run` loop and
//! the one-frame B1 interop spike. The proven negotiation recipe (B1, 2026-06-13)
//! lives here: concrete EGL-queried modifiers as a `DONT_FIXATE|MANDATORY` choice
//! (an INVALID-only offer makes KWin allocate empty `type=-1` buffers),
//! `SPA_PARAM_Buffers` `dataType=DmaBuf`, no `MAP_BUFFERS` (read the fd directly).

use std::os::fd::{BorrowedFd, OwnedFd, RawFd};

use pipewire as pw;
use pw::spa;

/// DRM `DRM_FORMAT_XRGB8888` ('XR24') — the DRM fourcc for SPA `BGRx`
/// (memory order B,G,R,x == little-endian 0xXXRRGGBB).
pub const DRM_FORMAT_XRGB8888: u32 = 0x3432_5258;
/// `DRM_FORMAT_MOD_INVALID` — "let the driver pick an implicit modifier".
const DRM_MOD_INVALID: i64 = 0x00ff_ffff_ffff_ffff;

/// One dmabuf plane handed to EGL. `fd` is a `dup()` of the PipeWire buffer's
/// plane fd (owned, so it outlives the buffer recycle).
pub struct DmabufPlane {
    pub fd: OwnedFd,
    pub offset: u32,
    pub stride: i32,
}

/// A single captured frame, in whichever buffer form KWin negotiated.
pub enum CapturedFrame {
    Dmabuf {
        planes: Vec<DmabufPlane>,
        modifier: u64,
        fourcc: u32,
        width: u32,
        height: u32,
    },
    Shm {
        bytes: Vec<u8>,
        stride: i32,
        width: u32,
        height: u32,
    },
}

/// Read the `SPA_META_Header` presentation timestamp (`CLOCK_MONOTONIC` ns, filled
/// by KWin from presentation feedback). `None` if the metadata is absent — the
/// caller falls back to a monotonic clock sampled at dequeue.
pub fn read_pts_ns(buffer: &pw::buffer::Buffer) -> Option<i64> {
    buffer
        .find_meta::<spa::buffer::meta::MetaHeader>()
        .map(|h| h.pts())
        .filter(|&pts| pts > 0)
}

/// Build a [`CapturedFrame`] from a dequeued buffer, choosing the arm by the
/// buffer's data type. dmabuf plane fds are `dup()`'d so they outlive the buffer.
pub fn build_frame(
    buffer: &mut pw::buffer::Buffer,
    info: spa::param::video::VideoInfoRaw,
) -> Result<CapturedFrame, String> {
    let size = info.size();
    let (width, height) = (size.width, size.height);
    let modifier = info.modifier();
    let datas = buffer.datas_mut();
    if datas.is_empty() {
        return Err("buffer has no data planes".into());
    }

    // KWin can report a dmabuf plane with an Unknown/unset SPA type, so decide the
    // path from fd + CPU pointer + the negotiated modifier, not the enum alone.
    let d0 = &datas[0];
    let dtype = d0.type_();
    let fd0 = d0.fd();
    let data_null = d0.as_raw().data.is_null();

    let is_dmabuf = dtype == spa::buffer::DataType::DmaBuf
        || (fd0 >= 0 && data_null && modifier != 0);
    let is_shm = matches!(
        dtype,
        spa::buffer::DataType::MemFd | spa::buffer::DataType::MemPtr
    ) || !data_null;

    if is_dmabuf {
        let mut planes = Vec::with_capacity(datas.len());
        for d in datas.iter() {
            let fd = d.fd();
            if fd < 0 {
                return Err(format!("dmabuf plane has invalid fd {fd}"));
            }
            // SAFETY: `fd` is a live dmabuf fd owned by the PipeWire buffer for the
            // duration of this callback; dup (F_DUPFD_CLOEXEC) into an OwnedFd so it
            // stays valid after the buffer is recycled.
            let owned = unsafe { BorrowedFd::borrow_raw(fd as RawFd) }
                .try_clone_to_owned()
                .map_err(|e| format!("dup dmabuf fd: {e}"))?;
            let chunk = d.chunk();
            planes.push(DmabufPlane { fd: owned, offset: chunk.offset(), stride: chunk.stride() });
        }
        Ok(CapturedFrame::Dmabuf { planes, modifier, fourcc: DRM_FORMAT_XRGB8888, width, height })
    } else if is_shm {
        let d = &mut datas[0];
        let stride = d.chunk().stride();
        let size = d.chunk().size() as usize;
        let bytes = d
            .data()
            .map(|s| s[..size.min(s.len())].to_vec())
            .ok_or("SHM buffer is not mapped")?;
        Ok(CapturedFrame::Shm { bytes, stride, width, height })
    } else {
        Err(format!(
            "buffer is neither dmabuf nor mapped SHM (type={dtype:?}, fd={fd0}, \
             data_null={data_null}) — likely an unnegotiated/empty buffer"
        ))
    }
}

/// Build a serialized EnumFormat pod for BGRx with a `DONT_FIXATE | MANDATORY`
/// modifier choice carrying the concrete EGL-queried `modifiers` (the trigger for
/// dmabuf buffer allocation; falls back to implicit INVALID if the list is empty).
pub fn video_format_pod(modifiers: &[u64]) -> Vec<u8> {
    use spa::param::format::{FormatProperties, MediaSubtype, MediaType};
    use spa::param::{video::VideoFormat, ParamType};
    use spa::pod::{ChoiceValue, Property, PropertyFlags, Value};
    use spa::utils::{Choice, ChoiceEnum, ChoiceFlags, Fraction, Rectangle, SpaTypes};

    let mut obj = pw::spa::pod::object! {
        SpaTypes::ObjectParamFormat,
        ParamType::EnumFormat,
        pw::spa::pod::property!(FormatProperties::MediaType, Id, MediaType::Video),
        pw::spa::pod::property!(FormatProperties::MediaSubtype, Id, MediaSubtype::Raw),
        pw::spa::pod::property!(FormatProperties::VideoFormat, Id, VideoFormat::BGRx),
        pw::spa::pod::property!(
            FormatProperties::VideoSize,
            Choice, Range, Rectangle,
            Rectangle { width: 3440, height: 1440 },
            Rectangle { width: 1, height: 1 },
            Rectangle { width: 8192, height: 8192 }
        ),
        pw::spa::pod::property!(
            FormatProperties::VideoFramerate,
            Choice, Range, Fraction,
            Fraction { num: 60, denom: 1 },
            Fraction { num: 0, denom: 1 },
            Fraction { num: 1000, denom: 1 }
        ),
        pw::spa::pod::property!(
            FormatProperties::VideoMaxFramerate,
            Fraction,
            Fraction { num: 60, denom: 1 }
        ),
    };

    // The modifier property needs DONT_FIXATE | MANDATORY, which the `property!`
    // macro can't express — hand-build it.
    let mods: Vec<i64> = if modifiers.is_empty() {
        vec![DRM_MOD_INVALID]
    } else {
        modifiers.iter().map(|&m| m as i64).collect()
    };
    obj.properties.push(Property {
        key: FormatProperties::VideoModifier.as_raw(),
        flags: PropertyFlags::MANDATORY | PropertyFlags::DONT_FIXATE,
        value: Value::Choice(ChoiceValue::Long(Choice(
            ChoiceFlags::empty(),
            ChoiceEnum::Enum { default: mods[0], alternatives: mods },
        ))),
    });

    pw::spa::pod::serialize::PodSerializer::serialize(std::io::Cursor::new(Vec::new()), &Value::Object(obj))
        .expect("serialize format pod")
        .0
        .into_inner()
}

/// Build a serialized `SPA_PARAM_Buffers` pod declaring dmabuf buffers (the
/// `dataType` flags-choice is what makes the producer allocate real dmabufs).
pub fn buffers_pod(width: u32, height: u32) -> Vec<u8> {
    use spa::param::ParamType;
    use spa::pod::{ChoiceValue, Object, Property, PropertyFlags, Value};
    use spa::sys as s;
    use spa::utils::{Choice, ChoiceEnum, ChoiceFlags, SpaTypes};

    let stride = width as i32 * 4;
    let size = stride * height as i32;
    let data_type_mask: i32 = 1i32 << s::SPA_DATA_DmaBuf as i32;

    let int = |v: i32| Value::Int(v);
    let obj = Object {
        type_: SpaTypes::ObjectParamBuffers.as_raw(),
        id: ParamType::Buffers.as_raw(),
        properties: vec![
            Property {
                key: s::SPA_PARAM_BUFFERS_buffers as u32,
                flags: PropertyFlags::empty(),
                value: Value::Choice(ChoiceValue::Int(Choice(
                    ChoiceFlags::empty(),
                    ChoiceEnum::Range { default: 8, min: 2, max: 16 },
                ))),
            },
            Property { key: s::SPA_PARAM_BUFFERS_blocks as u32, flags: PropertyFlags::empty(), value: int(1) },
            Property { key: s::SPA_PARAM_BUFFERS_size as u32, flags: PropertyFlags::empty(), value: int(size) },
            Property { key: s::SPA_PARAM_BUFFERS_stride as u32, flags: PropertyFlags::empty(), value: int(stride) },
            Property {
                key: s::SPA_PARAM_BUFFERS_dataType as u32,
                flags: PropertyFlags::empty(),
                value: Value::Choice(ChoiceValue::Int(Choice(
                    ChoiceFlags::empty(),
                    ChoiceEnum::Flags { default: data_type_mask, flags: vec![] },
                ))),
            },
        ],
    };
    pw::spa::pod::serialize::PodSerializer::serialize(std::io::Cursor::new(Vec::new()), &Value::Object(obj))
        .expect("serialize buffers pod")
        .0
        .into_inner()
}
