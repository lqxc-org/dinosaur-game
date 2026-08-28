use bevy::{
    app::{Plugin, Update},
    asset::AssetServer,
    ecs::schedule::IntoScheduleConfigs,
    input::ButtonInput,
    prelude::{
        Assets, Commands, KeyCode, MouseButton, Query, Res, ResMut, Touches, Transform, With,
    },
    sprite::Sprite,
    state::{
        condition::in_state,
        state::{OnEnter, OnExit},
    },
    time::{Time, Virtual},
};
use bevy_egui::EguiContexts;
use bevy_kira_audio::{Audio, AudioControl, AudioInstance};

use crate::{
    components::Dino, utils::cleanup_component, utils::egui_wants_pointer, DinoJumpMusic,
    GameConfig, GameScreen, GameStatus,
};

pub struct DinoPlugin;

impl Plugin for DinoPlugin {
    fn build(&self, app: &mut bevy::app::App) {
        app.add_systems(
            Update,
            (
                dino_pos_fix_system,
                dino_jump_system,
                dino_jump_animation,
                update_dino_sprite_from_config,
            )
                .run_if(in_state(GameScreen::PlayScreen)),
        )
        .add_systems(OnEnter(GameScreen::PlayScreen), setup_dino)
        .add_systems(
            OnExit(GameScreen::PlayScreen),
            (cleanup_component::<Dino>, clean_dino_jump_music),
        );
    }
}

fn setup_dino(mut commands: Commands, assert_server: Res<AssetServer>, config: Res<GameConfig>) {
    let sound = assert_server.load("Jump.ogg");
    commands.insert_resource(DinoJumpMusic(sound));
    commands.spawn(Dino::new(&config));
}

fn clean_dino_jump_music(mut commands: Commands) {
    commands.remove_resource::<DinoJumpMusic>();
}

fn dino_pos_fix_system(
    mut query: Query<(&mut Transform, &Sprite), With<Dino>>,
    game_status: Res<GameStatus>,
    config: Res<GameConfig>,
) {
    for (mut transform, sprite) in query.iter_mut() {
        let window_width = game_status.window_width;
        let dino_width = sprite.custom_size.map(|s| s.x).unwrap_or(config.dino_width);
        transform.translation.x =
            -window_width / 2.0 + dino_width / 2.0 + config.dino_x_offset * window_width;
    }
}

/// Dino will jump when user press space, w, Up, k, or left mouse button
#[allow(clippy::too_many_arguments)]
fn dino_jump_system(
    mut dino_query: Query<&mut Dino>,
    keyboard: Res<ButtonInput<KeyCode>>,
    mouse: Res<ButtonInput<MouseButton>>,
    touch: Res<Touches>,
    time: Res<Time<Virtual>>,
    sound: Res<DinoJumpMusic>,
    audio: Res<Audio>,
    mut contexts: EguiContexts,
) {
    if time.is_paused() {
        return;
    }

    // Only process mouse/touch if egui doesn't want the input
    let pointer_input = if egui_wants_pointer(&mut contexts) {
        false
    } else {
        mouse.just_pressed(MouseButton::Left) || touch.any_just_pressed()
    };

    if keyboard.just_pressed(KeyCode::Space)
        || keyboard.just_pressed(KeyCode::KeyW)
        || keyboard.just_pressed(KeyCode::ArrowUp)
        || keyboard.just_pressed(KeyCode::KeyK)
        || pointer_input
    {
        for mut dino in dino_query.iter_mut() {
            if dino.in_air_start_time.is_some() {
                continue;
            } else {
                let handle = audio.play(sound.clone()).handle();
                dino.jump_sound = Some(handle);
                dino.in_air_start_time = Some(*time);
            }
        }
    }
}

fn dino_jump_animation(
    time: Res<Time<Virtual>>,
    mut query: Query<(&mut Transform, &mut Dino)>,
    mut audio_instances: ResMut<Assets<AudioInstance>>,
    config: Res<GameConfig>,
) {
    if time.is_paused() {
        return;
    }
    // Base Y position is ground position plus half the dino height
    let base_y = config.ground_y_pos + config.dino_height / 2.0;
    for (mut transform, mut dino) in query.iter_mut() {
        if let Some(start_time) = dino.in_air_start_time {
            let elapsed = time.elapsed() - start_time.elapsed();
            // Over
            let y = if elapsed.as_millis() > 500 {
                if let Some(handle) = dino.jump_sound.take() {
                    if let Some(mut instance) = audio_instances.get_mut(&handle) {
                        instance.pause(Default::default());
                    }
                }
                dino.in_air_start_time = None;
                base_y
            } else {
                let x = elapsed.as_millis() as f64 / 500.0 * std::f64::consts::PI;
                let x = x as f32;
                x.sin() * config.dino_jump_height + base_y
            };
            transform.translation.y = y;
        } else {
            // When not jumping, keep dino at base Y position (follows ground)
            transform.translation.y = base_y;
        }
    }
}

/// Update dino sprite size based on config changes in real-time
fn update_dino_sprite_from_config(
    mut query: Query<&mut Sprite, With<Dino>>,
    config: Res<GameConfig>,
) {
    for mut sprite in query.iter_mut() {
        let new_size = bevy::math::Vec2::new(config.dino_width, config.dino_height);
        if sprite.custom_size != Some(new_size) {
            sprite.custom_size = Some(new_size);
        }
    }
}
