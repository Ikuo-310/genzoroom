//! Read-only support accounting using the isolated build's actual Native functions.
use lightcraft_develop::DevelopSettings;
use lightcraft_pipeline::{Quality, local};
use lightcraft_raster::blur::box_radii;
use serde_json::{Value, json};

fn blur(sigma: f32) -> Value {
    let radii = box_radii(sigma);
    json!({"sigma":sigma,"boxRadii":radii,"perAxisSupport":radii.iter().sum::<usize>()})
}

fn main() {
    let mut rows = Vec::new();
    for edge in [1024usize,2048,4096,6000] {
        let mut s = DevelopSettings::default();
        s.effects.texture = 100.0;
        s.effects.clarity = 100.0;
        s.effects.dehaze = 100.0;
        let sig = local::plane_sigmas(&s,edge as f64,Quality::Full);
        let clarity = sig.clarity.unwrap_or(0.0);
        let step = local::guided_fast_step(clarity);
        let mut nr = Vec::new();
        for smoothness in [50.0,100.0] {
            s.detail.nr_luminance = 100.0;
            s.detail.nr_color = 100.0;
            s.detail.nr_color_smoothness = smoothness;
            let scale = local::detail_scale(edge as f64,2048usize.max(edge));
            let (lum,col) = local::nr_params(&s,scale);
            nr.push(json!({"colorSmoothness":smoothness,"scale":scale,
                "luminance":lum.map(|p|blur(p.sigma)),"color":col.map(|p|blur(p.sigma))}));
        }
        rows.push(json!({"edge":edge,"measuredImageGrid":edge<=2048,
            "texture":blur(sig.texture.unwrap_or(0.0)),"dark":blur(sig.dark.unwrap_or(0.0)),
            "clarity":blur(clarity),"guidedStep":step,"guidedLowBlur":blur(clarity/step as f32),
            "nrAtMaximumAmount":nr}));
    }
    println!("{}",json!({"rows":rows}));
}
