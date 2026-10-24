# Fluid Design Language & Non-Uncanny 3D Reference Head Research

**Context:** Visual audit of the final 3D head implementation (`Articulate/mouth-demo`) against the product goals in `Visual_Speech_Coach_Roadmap.md` and `mouth-demo-spec.md`.

> **Core Design Goal:** For deaf and hard-of-hearing (DHH) learners, the 3D head is an **illustrative biomechanical instrument**, not a conversational digital human. Visual cues must be pre-attentively readable at a glance without triggering uncanny valley discomfort.

---

## 1. Visual Audit of the Current 3D Implementation Clip

### Five Root Causes of the "Uncanny" Look & Cue Ambiguity

1. **The "Severed Bald Mannequin" Silhouette (`Articulate/mouth-demo/src/hologram.js`, `classify()`)**
   - `classify()` hides `/hair|glasses|lash|brow|beard/i` while retaining the realistic Ready Player Me cranial mesh and eyeballs.
   - Because `EyeLeft` and `EyeRight` render at `rowFreq: 400` and sample the dark diffuse luminance around the eye sockets (`hologram.js` lines 164–171), the eyes appear as sunken, hollow clusters of dark beads on a bald head—immediately triggering an uncanny response.

2. **Trypophobic 3D Bead Shading on a Light Background (`Articulate/mouth-demo/src/hologram.js`, `dotLattice()`)**
   - The original spec (`mouth-demo-spec.md` §13) envisioned glowing horizontal scanlines on a dark background. When converted to a light background (`#FFFFFF` → `#CBD7E6`) with dark navy (`#203E68`) individually lit fake spheres (`sn = vec3(q / R, sqrt(...))`), the surface reads as porous/stippled mannequin skin rather than light projection.
   - Along the neck and jawline, cylindrical coordinate wrapping (`atan(vRestPos.x - uCylC.x, vRestPos.z - uCylC.y)`) compresses dot rows on steep slopes, creating visual moiré noise.

3. **The "Ventriloquist Puppet" Cheek Crease (`aLip` & `LIP.line` in `Articulate/mouth-demo/src/hologram.js`)**
   - `addLipAttribute()` computes `aLip` from vertex displacements of `mouthPucker` and `mouthFunnel`. Because those blendshapes deform the cheeks and perioral region, the `vLip = 0.5` isoline lies far outside the actual vermilion border of the lips.
   - Drawing a hard solid contour at `abs(vLip - 0.5)` (`hologram.js` line 179) etches a wide diamond seam across the cheeks during `round-lips` ("oo") and `open-jaw` ("ah").

4. **Monochrome Mouth Interior Destroys Articulator Figure-Ground Contrast (`Articulate/mouth-demo/src/hologram.js`)**
   - Both `Wolf3D_Head` (skin/lips) and `Wolf3D_Teeth` (teeth/inner mouth) render in the exact same `#203E68` navy dots.
   - When the jaw drops (`open-jaw`), the upper lip, upper teeth, oral cavity, lower teeth, and lower lip merge into one noisy dark patch. Comparing hologram mode with `?style=solid` shows how much clearer the mouth opening is when lips, teeth, and oral cavity have distinct value/color channels.

5. **Heavy, Occluding Bullseye Ring (`Articulate/mouth-demo/src/highlight.js`)**
   - The three-ring opaque billboard (`#203E68` / `#FFFFFF` / `#203E68`) with `depthTest: false` sits flat over the cheeks, nose tip, and chin, competing with the mouth geometry instead of guiding the eye into the movement.

---

## 2. Domain Research: Fluid Design Language in Spatial & Biomedical UI

Research across modern spatial computing interfaces (visionOS personas/Siri fluid shaders, biomedical 3D anatomy visualizers) and clinical speech biofeedback (`Visual_Speech_Coach_Roadmap.md` §4, Hitchcock et al., Preston et al., VocalTractLab) points to four foundational principles:

### 2.1 Sculptural Abstraction ("Frosted Porcelain / Subsurface Glass")
- **Why digital humans fall into the Uncanny Valley:** Whenever a mesh combines realistic human cranial/eye proportions with discontinuous skin textures (holes, stippled beads, or noisy alpha cutouts), human visual perception flags it as pathology or decay.
- **The Fluid Alternative:** Treat the head as a **continuous, smooth sculptural bust** rendered with **wrapped diffuse lighting (stylized subsurface scattering)** and a **smooth Fresnel silhouette rim**:
  - `wrappedDiffuse = max(0.0, (dot(N, L) + w) / (1.0 + w))`
  - `fresnel = pow(1.0 - max(0.0, dot(N, V)), p)`
- If holographic texture is desired, use **ultra-subtle, continuous elevation contour lines** (low-contrast harmonic bands that never punch holes through the surface or break the silhouette into beads).

### 2.2 Spatial Attention & Cranial De-Emphasis
- In speech-language pathology (SLP) biofeedback tools, the forehead, cranium, and eyeballs carry **zero articulatory information** for vowels (`/i/`, `/u/`, `/ɑ/`), yet in a full-head portrait they consume ~60% of visual attention.
- **Design Pattern:**
  - Apply a **smooth radial/vertical alpha & contrast falloff** centered on the lower face (`uMouthCenter`), softly dissolving the upper cranium, ears, and base of the neck into the background gradient.
  - Render the eyes as calm, unified matte sculptural forms matching the face surface (not dense dark bead clusters), or frame the camera closer to the lower two-thirds of the face so the nose, lips, and jaw dominate the composition.

### 2.3 Semantic Color & Value Separation for Articulators
For DHH learners to read lip rounding (`mouthPucker`/`mouthFunnel`), lip spreading (`mouthSmile`/`mouthStretch`), and jaw opening (`jawOpen`) instantaneously from across a room:

| Anatomical Structure | Visual Role | Recommended Treatment |
| :--- | :--- | :--- |
| **Face & Jaw Surface** | Reference frame & jaw motion | Smooth, matte-translucent neutral surface (e.g., warm alabaster/sage `#dbe7e3` or soft porcelain with a subtle Fresnel rim). |
| **Vermilion Border (Lips)** | Primary external target | Smooth, saturated semantic accent (e.g., warm coral/terracotta `#dd967f` or deep forest/teal) driven by diffuse chroma (`redness`), **without** the `vLip = 0.5` cheek line. |
| **Teeth (`Wolf3D_Teeth`)** | Aperture & jaw-drop landmark | Clean, solid off-white (`#F8F9F5`) with simple depth darkening toward the back of the mouth—never dotted. |
| **Oral Cavity Interior** | Figure-ground negative space | Deep, smooth dark shadow (`#132620` or `#141E30`) so the exact geometry of the mouth opening reads as a crisp silhouette. |

### 2.4 Kinetic Vector Cues Instead of a Static Bullseye
- A static circle around the mouth tells the user *where* the mouth is (which they already know), but not *what movement* is happening.
- **Fluid Biofeedback Cues:**
  1. **Lip-Surface Luminescence:** During the `hold` phase, pulse the lip shader's own brightness/saturation and rim glow directly on the 3D lip geometry (`L * uHold`).
  2. **Directional Motion Arcs:** Replace the heavy double-navy bullseye in `highlight.js` with thin, feathered, semi-transparent directional arcs or chevrons tailored to each cue:
     - `round-lips` (`/u/`): Four small curved arcs gently compressing **inward** toward the center of the lips.
     - `spread-lips` (`/i/`): Two subtle horizontal arcs expanding **outward** at the lip corners.
     - `open-jaw` (`/ɑ/`): A soft inferior arc beneath the chin guiding **downward** jaw drop.

### 2.5 Cohesive Brand Palette & Translucent Side Cutaway
- **Palette Unification:** The main web app (`Articulate/apps/web/src/styles.css`) uses an approachable, warm editorial palette (`#f7f8f2` background, `#233e35` deep forest green, `#dbe7e3` soft sage, `#dd967f` coral-terracotta), whereas `Articulate/mouth-demo/src/styles.css` uses cold steel blue and navy (`#CBD7E6`, `#203E68`). Aligning `mouth-demo` to the main app's palette makes the 3D panel feel native rather than bolted on.
- **Upgrading the 2D Cutaway (`Articulate/mouth-demo/src/cutaway.js`):**
  - Replace the coarse polka-dot SVG `<pattern>` on the tongue with a **smooth, layered translucent gradient fill** and a **glowing palatal target zone** (highlighting the anterior hard palate for `/i/`, the posterior soft palate/velum + lip protrusion for `/u/`, and the lowered pharyngeal/mandibular space for `/ɑ/`).
  - Remove the hard vertical divider line between the 3D profile and 2D cutaway so both views float in the same continuous spatial stage.

---

## 3. Prioritized Implementation Checklist (For Future Code Changes)

1. **Remove `LIP.line` cheek contour** in `Articulate/mouth-demo/src/hologram.js` (lines 177–180) so `vLip = 0.5` no longer draws a dark ring across the cheeks.
2. **Replace `dotLattice` stippled spheres** in `Articulate/mouth-demo/src/hologram.js` (lines 99–131) with a continuous wrapped-diffuse + Fresnel sculptural shader (with optional ultra-subtle contour sheen).
3. **Separate material treatments** for `Wolf3D_Head` (translucent sculptural skin + distinct smooth lip tint) vs. `Wolf3D_Teeth` (clean solid teeth + dark oral cavity interior).
4. **Add upper-cranium/eye de-emphasis** via a smooth radial distance fade from `uMouthCenter` so the head no longer looks like a stark bald mannequin.
5. **Refine `Articulate/mouth-demo/src/highlight.js`** into a thin, feathered, low-occlusion ring or cue-specific directional arcs.
6. **Unify palette & cutaway styling** in `Articulate/mouth-demo/src/cutaway.js` and `Articulate/mouth-demo/src/styles.css` with the main Articulate UI.

