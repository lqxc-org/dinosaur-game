use bevy::prelude::*;
use bevy_egui::EguiContexts;

use crate::utils::egui_wants_pointer;
use crate::{utils::cleanup_component, GameScreen};

pub struct GameOverPlugin;

impl Plugin for GameOverPlugin {
    fn build(&self, app: &mut bevy::prelude::App) {
        app.add_systems(OnEnter(GameScreen::GameOverScreen), show_game_over_info)
            .add_systems(FixedUpdate, restart_game_by_space)
            .add_systems(
                OnExit(GameScreen::GameOverScreen),
                cleanup_component::<GameOverTextUI>,
            );
    }
}

#[derive(Component)]
pub struct GameOverTextUI;

fn show_game_over_info(mut commands: Commands) {
    info!("Showing Game Over");
    commands
        .spawn((
            GameOverTextUI,
            Node {
                display: Display::Flex,
                flex_direction: FlexDirection::Column,
                justify_content: JustifyContent::Center,
                align_items: AlignItems::Center,
                row_gap: Val::Px(16.0),
                column_gap: Val::Px(16.0),
                width: Val::Percent(100.0),
                height: Val::Percent(100.0),
                ..Default::default()
            },
            BackgroundColor(Color::linear_rgba(1.0, 1.0, 1.0, 0.8)),
        ))
        .with_children(|parent| {
            parent.spawn((
                Text::new("Press Space/Touch/Click to Restart!"),
                TextFont {
                    font_size: FontSize::Px(64.0),
                    ..Default::default()
                },
                TextLayout {
                    justify: Justify::Center,
                    ..Default::default()
                },
                TextColor(Color::BLACK),
            ));
        });
}

fn restart_game_by_space(
    keyboard: Res<ButtonInput<KeyCode>>,
    mouse: Res<ButtonInput<MouseButton>>,
    touches: Res<Touches>,
    cur_screen: Res<State<GameScreen>>,
    mut next_state: ResMut<NextState<GameScreen>>,
    mut contexts: EguiContexts,
) {
    // Only process mouse/touch if egui doesn't want the input
    let pointer_input = if egui_wants_pointer(&mut contexts) {
        false
    } else {
        mouse.just_pressed(MouseButton::Left) || touches.any_just_pressed()
    };

    if *cur_screen == GameScreen::GameOverScreen
        && (keyboard.just_pressed(KeyCode::Space) || pointer_input)
    {
        info!("Restart Game");
        next_state.set(GameScreen::StartScreen);
    }
}
