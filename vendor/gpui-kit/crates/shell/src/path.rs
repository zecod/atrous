//! Native GPUI path materialization.

use gpui::{
    App, Bounds, Element, ElementId, GlobalElementId, InspectorElementId, IntoElement, LayoutId,
    Pixels, Point, Refineable as _, Style, StyleRefinement, Styled as _, Window, point, px,
};

use crate::{
    spec::{BackgroundKind, BackgroundSpec, SpecOp},
    value::{Bridged, scaled_px},
};

#[derive(Clone, Copy)]
enum Coordinate {
    Pixels(f32),
    Percent(f32),
}

impl Coordinate {
    fn parse(value: &Bridged) -> Option<Self> {
        match value {
            Bridged::Number(value) if value.is_finite() => Some(Self::Pixels(*value as f32)),
            Bridged::Str(value) => value
                .strip_suffix('%')
                .and_then(|value| value.parse::<f32>().ok())
                .filter(|value| value.is_finite())
                .map(|value| Self::Percent(value / 100.)),
            _ => None,
        }
    }

    fn resolve(self, start: Pixels, length: Pixels) -> Pixels {
        match self {
            Self::Pixels(value) => start + scaled_px(value),
            Self::Percent(value) => start + length * value,
        }
    }
}

fn command_point(args: &[Bridged], offset: usize, bounds: Bounds<Pixels>) -> Option<Point<Pixels>> {
    let x = Coordinate::parse(args.get(offset)?)?;
    let y = Coordinate::parse(args.get(offset + 1)?)?;
    Some(point(
        x.resolve(bounds.origin.x, bounds.size.width),
        y.resolve(bounds.origin.y, bounds.size.height),
    ))
}

/// What a path draws, kept apart from its element so a flowing one can be drawn
/// again on every frame by its root's [`flow_layer`] (HERDR).
#[derive(Clone)]
pub(crate) struct PathSpec {
    fill: bool,
    background: BackgroundSpec,
    stroke_width: Pixels,
    dash_array: Vec<Pixels>,
    /// HERDR: `PathBuilder.flow(speed)`: the dashes move along the path, px a second.
    flow: Option<f32>,
    commands: Vec<SpecOp>,
}

pub(crate) struct NativePath {
    spec: PathSpec,
    style: StyleRefinement,
    /// HERDR: set when the root draws this flowing path on its own layer.
    hosted_by: Option<gpui::EntityId>,
    /// HERDR: the opacity it's painted with (its ancestors'), for the flow layer.
    fade: f32,
}

impl NativePath {
    pub(crate) fn new(
        fill: bool,
        background: BackgroundSpec,
        stroke_width: f32,
        commands: Vec<SpecOp>,
        style: StyleRefinement,
    ) -> Self {
        let dash_array: Vec<Pixels> = commands
            .iter()
            .find_map(|op| match op {
                SpecOp::Method("dash_array", args) => Some(
                    args.iter()
                        .filter_map(|value| value.as_pixels().ok())
                        .collect(),
                ),
                _ => None,
            })
            .unwrap_or_default();
        let flow = commands.iter().find_map(|op| match op {
            SpecOp::Method("flow", args) => args.first().and_then(|v| v.as_f32().ok()).filter(|v| v.is_finite()),
            _ => None,
        });
        let flow = if fill { None } else { flow };
        Self {
            spec: PathSpec {
                fill,
                background,
                stroke_width: scaled_px(stroke_width),
                // A flow without dashes would move nothing: it gets a default pattern.
                dash_array: if flow.is_some() && dash_array.is_empty() { vec![px(6.), px(6.)] } else { dash_array },
                flow,
                commands,
            },
            style,
            hosted_by: None,
            fade: 1.0,
        }
    }

    /// HERDR: a flowing path whose view's root draws it on its flow layer (so a frame of
    /// its motion never builds, lays out or paints the view again). `fade`: the opacity
    /// it's painted with.
    pub(crate) fn hosted(mut self, view: gpui::EntityId, fade: f32) -> Self {
        if self.spec.flow.is_some() {
            self.hosted_by = Some(view);
            self.fade = fade;
        }
        self
    }

    pub(crate) fn flows(&self) -> bool {
        self.spec.flow.is_some()
    }
}

impl PathSpec {
    fn background(&self) -> Option<gpui::Background> {
        let color = |value: &str| Bridged::Str(value.to_owned()).as_color().ok();
        let background = match &self.background.kind {
            BackgroundKind::Solid { color: value } => gpui::solid_background(color(value)?),
            BackgroundKind::LinearGradient {
                angle,
                from,
                to,
                color_space,
            } => gpui::linear_gradient(
                *angle,
                gpui::linear_color_stop(color(&from.0)?, from.1),
                gpui::linear_color_stop(color(&to.0)?, to.1),
            )
            .color_space(match color_space.as_str() {
                "oklab" => gpui::ColorSpace::Oklab,
                _ => gpui::ColorSpace::Srgb,
            }),
            BackgroundKind::PatternSlash {
                color: value,
                width,
                interval,
            } => gpui::pattern_slash(color(value)?, *width, *interval),
            BackgroundKind::Checkerboard { color: value, size } => {
                gpui::checkerboard(color(value)?, *size)
            }
        };
        Some(background.opacity(self.background.opacity))
    }

    /// The dashes' shift at `clock_ms` (materialize's loop clock), for a flowing path.
    fn offset_at(&self, clock_ms: f64) -> Pixels {
        match self.flow {
            Some(speed) => px((clock_ms / 1000.0 * speed as f64) as f32),
            None => Pixels::ZERO,
        }
    }

    fn build(&self, bounds: Bounds<Pixels>, window: &Window) -> Option<gpui::Path<Pixels>> {
        self.build_at(bounds, window, crate::materialize::loop_clock_ms())
    }

    /// The path with a flow's dashes where they are at `clock_ms`.
    fn build_at(&self, bounds: Bounds<Pixels>, window: &Window, clock_ms: f64) -> Option<gpui::Path<Pixels>> {
        let command_point = |args: &[Bridged], offset, bounds| {
            command_point(args, offset, bounds).map(|p| p.map(|c| window.pixel_snap(c)))
        };
        let mut builder = if self.fill {
            gpui::PathBuilder::fill()
        } else {
            gpui::PathBuilder::stroke(self.stroke_width)
        };
        if !self.dash_array.is_empty() {
            builder = builder.dash_array(&self.dash_array).dash_offset(self.offset_at(clock_ms));
        }

        for command in &self.commands {
            let SpecOp::Method(name, args) = command else {
                continue;
            };
            match *name {
                "move_to" => builder.move_to(command_point(args, 0, bounds)?),
                "line_to" => builder.line_to(command_point(args, 0, bounds)?),
                "curve_to" => builder.curve_to(
                    command_point(args, 0, bounds)?,
                    command_point(args, 2, bounds)?,
                ),
                "cubic_bezier_to" => builder.cubic_bezier_to(
                    command_point(args, 0, bounds)?,
                    command_point(args, 2, bounds)?,
                    command_point(args, 4, bounds)?,
                ),
                "arc_to" => builder.arc_to(
                    command_point(args, 0, Bounds::new(point(px(0.), px(0.)), bounds.size))?,
                    args.get(2)?.as_pixels().ok()?,
                    args.get(3)?.is_truthy(),
                    args.get(4)?.is_truthy(),
                    command_point(args, 5, bounds)?,
                ),
                "close" => builder.close(),
                "dash_array" | "flow" => {}
                _ => {}
            }
        }
        builder.build().ok()
    }
}

impl IntoElement for NativePath {
    type Element = Self;

    fn into_element(self) -> Self::Element {
        self
    }
}

impl Element for NativePath {
    type RequestLayoutState = ();
    type PrepaintState = Option<gpui::Path<Pixels>>;

    fn id(&self) -> Option<ElementId> {
        None
    }

    fn source_location(&self) -> Option<&'static std::panic::Location<'static>> {
        None
    }

    fn request_layout(
        &mut self,
        _: Option<&GlobalElementId>,
        _: Option<&InspectorElementId>,
        window: &mut Window,
        cx: &mut App,
    ) -> (LayoutId, Self::RequestLayoutState) {
        let mut style = Style::default();
        style.refine(&self.style);
        (window.request_layout(style, [], cx), ())
    }

    fn prepaint(
        &mut self,
        _: Option<&GlobalElementId>,
        _: Option<&InspectorElementId>,
        bounds: Bounds<Pixels>,
        _: &mut Self::RequestLayoutState,
        window: &mut Window,
        _: &mut App,
    ) -> Self::PrepaintState {
        if let Some(view) = self.hosted_by {
            // HERDR: drawn by the root's flow layer, at its place and under its clip.
            let flow = Flow { bounds, mask: window.content_mask(), spec: self.spec.clone(), fade: self.fade };
            FLOWS.with(|f| f.borrow_mut().entry(view).or_default().push(flow));
            return None;
        }
        self.spec.build(bounds, window)
    }

    fn paint(
        &mut self,
        _: Option<&GlobalElementId>,
        _: Option<&InspectorElementId>,
        _: Bounds<Pixels>,
        _: &mut Self::RequestLayoutState,
        path: &mut Self::PrepaintState,
        window: &mut Window,
        _: &mut App,
    ) {
        if let Some(path) = path.take() {
            if let Some(background) = self.spec.background() {
                window.paint_path(path, background);
            }
        }
    }
}

// HERDR: flowing paths (`PathBuilder.flow(speed)`), drawn by their root on a layer of
// their own, like spinners (materialize.rs, `spin_layer`): a frame of motion rebuilds only
// the dashes, never the view (no script render, no materialize, no layout of the view).
// They move while the window is in front; in the back the dashes stand still where they are and
// nothing is scheduled. Frames come as often as the fastest flow moves one device pixel (where
// motion looks continuous; more frames draw the same picture), at most about 60 a second: 30 px a
// second on a 1x screen is 30 frames, each a whole-window redraw.

/// The most often a flow moves on (about 60 a second) and the least often (a very slow one).
const FLOW_FRAME_MIN: std::time::Duration = std::time::Duration::from_millis(16);
const FLOW_FRAME_MAX: std::time::Duration = std::time::Duration::from_millis(100);

/// `ATROUS_ANIMATE_BEHIND=1`: flows move in a window that isn't in front too (tests measuring
/// them in a window opened behind, ATROUS_BACKGROUND, which never comes to the front).
fn animate_behind() -> bool {
    static ON: std::sync::OnceLock<bool> = std::sync::OnceLock::new();
    *ON.get_or_init(|| std::env::var_os("ATROUS_ANIMATE_BEHIND").is_some_and(|v| v == "1"))
}

#[derive(Clone)]
struct Flow {
    bounds: Bounds<Pixels>,
    mask: gpui::ContentMask<Pixels>,
    spec: PathSpec,
    fade: f32,
}

thread_local! {
    static FLOWS: std::cell::RefCell<std::collections::HashMap<gpui::EntityId, Vec<Flow>>> =
        std::cell::RefCell::new(std::collections::HashMap::new());
    /// Views whose window went to the back: the clock their dashes stopped at.
    static STOPPED: std::cell::RefCell<std::collections::HashMap<gpui::EntityId, f64>> =
        std::cell::RefCell::new(std::collections::HashMap::new());
}

/// A view is built again: its flows register again as its paths prepaint.
pub(crate) fn clear_flows(view: gpui::EntityId) {
    FLOWS.with(|f| f.borrow_mut().remove(&view));
}

/// A view goes.
pub(crate) fn forget_flows(view: gpui::EntityId) {
    clear_flows(view);
    STOPPED.with(|s| s.borrow_mut().remove(&view));
}

/// `view`'s flowing paths, moved on to now; while any is drawn and the window is in
/// front, the root is drawn again once the fastest has moved a device pixel.
pub(crate) fn flow_layer(view: gpui::EntityId) -> gpui::AnyElement {
    gpui::canvas(
        |_, _, _| {},
        move |_, _, window, cx| {
            let flows = FLOWS.with(|f| f.borrow().get(&view).cloned()).unwrap_or_default();
            if flows.is_empty() {
                return;
            }
            // In the back the dashes stay where they were when the window lost the front, even
            // when something else (a spinner) draws the window again.
            let moving = window.is_window_active() || animate_behind();
            let now = crate::materialize::loop_clock_ms();
            let clock = STOPPED.with(|s| {
                let mut s = s.borrow_mut();
                if moving {
                    s.remove(&view);
                    now
                } else {
                    *s.entry(view).or_insert(now)
                }
            });
            for flow in &flows {
                let Some(path) = flow.spec.build_at(flow.bounds, window, clock) else { continue };
                let Some(background) = flow.spec.background() else { continue };
                window.with_content_mask(Some(flow.mask.clone()), |window| {
                    window.paint_path(path, background.opacity(flow.fade));
                });
            }
            if moving {
                let fastest = flows.iter().filter_map(|f| f.spec.flow).map(f32::abs).fold(0., f32::max) * window.scale_factor();
                let step = if fastest > 0. { std::time::Duration::from_secs_f32(1. / fastest) } else { FLOW_FRAME_MAX };
                crate::materialize::wake_view_soon(step.clamp(FLOW_FRAME_MIN, FLOW_FRAME_MAX), window, cx);
            }
        },
    )
    .absolute()
    .size_full()
    .into_any_element()
}
