use bevy::prelude::*;
use bevy_egui::EguiContexts;

pub fn cleanup_component<C: Component>(queries: Query<Entity, With<C>>, mut commands: Commands) {
    for entity in queries {
        commands.entity(entity).despawn();
    }
}

/// Check if egui wants pointer input (e.g., clicking on debug window)
/// Returns true if egui wants to capture the pointer, false otherwise
pub fn egui_wants_pointer(contexts: &mut EguiContexts) -> bool {
    contexts
        .ctx_mut()
        .map(|ctx| ctx.egui_wants_pointer_input())
        .unwrap_or(false)
}
