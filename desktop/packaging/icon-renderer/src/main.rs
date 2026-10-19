use std::{env, fs, path::PathBuf, process::ExitCode};

fn render(args: &[String]) -> Result<(), String> {
    if args.len() != 6 {
        return Err(
            "usage: genzoroom-svg-rasterizer input.svg output.png width height padding".into(),
        );
    }
    let input = PathBuf::from(&args[1]);
    let output = PathBuf::from(&args[2]);
    let width = args[3].parse::<u32>().map_err(|_| "invalid_width")?;
    let height = args[4].parse::<u32>().map_err(|_| "invalid_height")?;
    let padding = args[5].parse::<f32>().map_err(|_| "invalid_padding")?;
    if width == 0 || height == 0 || !padding.is_finite() || padding < 0.0 {
        return Err("invalid_render_dimensions".into());
    }

    let svg = fs::read(&input).map_err(|_| "svg_read_failed")?;
    let options = resvg::usvg::Options {
        resources_dir: input
            .canonicalize()
            .ok()
            .and_then(|path| path.parent().map(PathBuf::from)),
        ..resvg::usvg::Options::default()
    };
    let tree = resvg::usvg::Tree::from_data(&svg, &options).map_err(|_| "svg_parse_failed")?;
    let content_width = width as f32 - padding * 2.0;
    let content_height = height as f32 - padding * 2.0;
    if content_width <= 0.0 || content_height <= 0.0 {
        return Err("padding_exceeds_canvas".into());
    }

    let svg_size = tree.size();
    let scale = (content_width / svg_size.width()).min(content_height / svg_size.height());
    let translate_x = (width as f32 - svg_size.width() * scale) / 2.0;
    let translate_y = (height as f32 - svg_size.height() * scale) / 2.0;
    let transform = resvg::tiny_skia::Transform::from_scale(scale, scale)
        .post_translate(translate_x, translate_y);
    let mut pixmap =
        resvg::tiny_skia::Pixmap::new(width, height).ok_or("pixmap_allocation_failed")?;
    resvg::render(&tree, transform, &mut pixmap.as_mut());
    pixmap
        .save_png(output)
        .map_err(|_| "png_write_failed".to_string())
}

fn main() -> ExitCode {
    match render(&env::args().collect::<Vec<_>>()) {
        Ok(()) => ExitCode::SUCCESS,
        Err(code) => {
            eprintln!("{code}");
            ExitCode::FAILURE
        }
    }
}
