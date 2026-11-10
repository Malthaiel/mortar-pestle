//! Reports where its content was laid out, read off the live layout (iced 0.14
//! has no bounds query without the extra `iced_selector` crate).

use iced::advanced::layout::{self, Layout};
use iced::advanced::widget::{Operation, Tree, Widget, tree};
use iced::advanced::{Clipboard, Shell, mouse, renderer};
use iced::{Element, Event, Length, Rectangle, Renderer, Size, Theme};

pub struct Measured<'a, Message> {
    content: Element<'a, Message>,
    on_change: Box<dyn Fn(Rectangle) -> Message + 'a>,
}

pub fn measured<'a, Message>(content: impl Into<Element<'a, Message>>, on_change: impl Fn(Rectangle) -> Message + 'a) -> Measured<'a, Message> {
    Measured { content: content.into(), on_change: Box::new(on_change) }
}

impl<Message> Widget<Message, Theme, Renderer> for Measured<'_, Message> {
    fn tag(&self) -> tree::Tag {
        tree::Tag::of::<Option<Rectangle>>()
    }

    fn state(&self) -> tree::State {
        tree::State::new(None::<Rectangle>)
    }

    fn children(&self) -> Vec<Tree> {
        vec![Tree::new(&self.content)]
    }

    fn diff(&self, tree: &mut Tree) {
        tree.diff_children(std::slice::from_ref(&self.content));
    }

    fn size(&self) -> Size<Length> {
        self.content.as_widget().size()
    }

    fn layout(&mut self, tree: &mut Tree, renderer: &Renderer, limits: &layout::Limits) -> layout::Node {
        self.content.as_widget_mut().layout(&mut tree.children[0], renderer, limits)
    }

    fn update(&mut self, tree: &mut Tree, event: &Event, layout: Layout<'_>, cursor: mouse::Cursor, renderer: &Renderer, clipboard: &mut dyn Clipboard, shell: &mut Shell<'_, Message>, viewport: &Rectangle) {
        self.content.as_widget_mut().update(&mut tree.children[0], event, layout, cursor, renderer, clipboard, shell, viewport);
        let last = tree.state.downcast_mut::<Option<Rectangle>>();
        if *last != Some(layout.bounds()) {
            *last = Some(layout.bounds());
            shell.publish((self.on_change)(layout.bounds()));
        }
    }

    fn draw(&self, tree: &Tree, renderer: &mut Renderer, theme: &Theme, style: &renderer::Style, layout: Layout<'_>, cursor: mouse::Cursor, viewport: &Rectangle) {
        self.content.as_widget().draw(&tree.children[0], renderer, theme, style, layout, cursor, viewport);
    }

    fn mouse_interaction(&self, tree: &Tree, layout: Layout<'_>, cursor: mouse::Cursor, viewport: &Rectangle, renderer: &Renderer) -> mouse::Interaction {
        self.content.as_widget().mouse_interaction(&tree.children[0], layout, cursor, viewport, renderer)
    }

    // Passed on: iced's default stops operations here, so `focus`, `is_focused` and
    // `snap_to` never reached a widget inside (the music box wraps its whole content).
    fn operate(&mut self, tree: &mut Tree, layout: Layout<'_>, renderer: &Renderer, operation: &mut dyn Operation) {
        self.content.as_widget_mut().operate(&mut tree.children[0], layout, renderer, operation);
    }
}

impl<'a, Message: 'a> From<Measured<'a, Message>> for Element<'a, Message> {
    fn from(m: Measured<'a, Message>) -> Self {
        Element::new(m)
    }
}
