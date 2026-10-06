// Cleaning the noise out of the dark parts of the picture, live, on the graphics chip.
//
// What the exhibit camera gets wrong in a dim room is mostly *colour* noise: red and blue
// speckle in the shadows, where the sensor's gain is turned up furthest. The eye takes its sense
// of sharpness from brightness, not colour, so the colour can be smoothed a good deal before
// anything looks soft. That is the whole idea of `colour`: each frame is split into brightness
// and colour, the colour is averaged with its neighbours — only those of about the same
// brightness, so it never bleeds across an edge — and much more so in the dark than in the
// light. The deepest shadows get a little of the same done to their brightness too, for the
// grain.
//
// `colour + time` also averages each pixel with itself in the frames before, which is what the
// shutter's stacking does, but continuously. Noise is different in every frame and cancels; the
// scene is the same and stays. Wherever a pixel changes by more than noise would — something
// moved — the new frame is taken as it is, so a hand moving through the picture is not followed
// by a ghost of itself. The dark is averaged more than the light, because that is where the
// noise is and where a faint trail would be least seen.
//
// One small WebGL canvas does all of it, for the viewfinder (through js/frameguard.js) and for
// the photograph (through captureFrame), and hands its result back to be drawn wherever it is
// wanted. Without WebGL it hands back what it was given, and the exhibit is as it was.

const VERT = `
attribute vec2 pos;
varying vec2 uv;
void main() {
  uv = pos * 0.5 + 0.5;
  gl_Position = vec4(pos, 0.0, 1.0);
}`

const YCC = `
vec3 toYcc(vec3 c) {
  float y = dot(c, vec3(0.299, 0.587, 0.114));
  return vec3(y, (c.b - y) * 0.564, (c.r - y) * 0.713);
}
vec3 toRgb(vec3 v) {
  return vec3(v.x + 1.403 * v.z, v.x - 0.344 * v.y - 0.714 * v.z, v.x + 1.773 * v.y);
}
// How dark, 1 in the shadows and 0 from the mid-tones up: where the noise is.
float darkness(float y) { return 1.0 - smoothstep(0.12, 0.5, y); }
`

// Thirteen taps — the pixel, and two rings of six round it — rather than a full 5x5: half the
// reads, and in practice the same picture. Each is weighted by how close its brightness is to the
// middle one's, which is what keeps colour from crossing an edge.
const SPATIAL = `
precision mediump float;
uniform sampler2D src;
uniform vec2 px;
varying vec2 uv;
${YCC}
void main() {
  vec3 mid = toYcc(texture2D(src, uv).rgb);
  vec2 sumC = vec2(0.0);
  float sumY = 0.0;
  float total = 0.0;
  for (int ring = 0; ring < 3; ring++) {
    float r = ring == 0 ? 0.0 : (ring == 1 ? 1.6 : 3.4);
    for (int k = 0; k < 6; k++) {
      if (ring == 0 && k > 0) break;
      float a = (float(k) + (ring == 2 ? 0.5 : 0.0)) * 1.0472;
      vec3 s = toYcc(texture2D(src, uv + px * r * vec2(cos(a), sin(a))).rgb);
      float d = (s.x - mid.x) / 0.07;
      float w = exp(-0.5 * d * d);
      sumC += s.yz * w;
      sumY += s.x * w;
      total += w;
    }
  }
  float dark = darkness(mid.x);
  float colour = 0.3 + 0.7 * dark;
  float grain = 0.55 * dark * dark;
  vec2 c = mix(mid.yz, sumC / total, colour);
  float y = mix(mid.x, sumY / total, grain);
  gl_FragColor = vec4(clamp(toRgb(vec3(y, c)), 0.0, 1.0), 1.0);
}`

// The new frame against the running average of the frames before it.
const TEMPORAL = `
precision mediump float;
uniform sampler2D cur;
uniform sampler2D prev;
varying vec2 uv;
${YCC}
void main() {
  vec3 now = texture2D(cur, uv).rgb;
  vec3 was = texture2D(prev, uv).rgb;
  float y = dot(now, vec3(0.299, 0.587, 0.114));
  float moved = smoothstep(0.035, 0.11, abs(y - dot(was, vec3(0.299, 0.587, 0.114))));
  float keep = 0.72 * (1.0 - moved) * (0.35 + 0.65 * darkness(y));
  gl_FragColor = vec4(mix(now, was, keep), 1.0);
}`

const COPY = `
precision mediump float;
uniform sampler2D src;
varying vec2 uv;
void main() { gl_FragColor = texture2D(src, uv); }`

export const LIVE_MODES = ['off', 'colour', 'colour + time']

export function createLiveDenoise() {
  const canvas = document.createElement('canvas')
  const gl =
    canvas.getContext('webgl2', { premultipliedAlpha: false, antialias: false, depth: false }) ||
    canvas.getContext('webgl', { premultipliedAlpha: false, antialias: false, depth: false })

  let mode = 'off'
  let cost = 0 // milliseconds a frame, smoothed, for the overlay

  if (!gl) {
    return {
      available: false,
      get mode() {
        return mode
      },
      set mode(next) {
        mode = next
      },
      get cost() {
        return 0
      },
      frame: (source) => source,
      still: () => null,
    }
  }

  function program(fragment) {
    const shader = (type, text) => {
      const s = gl.createShader(type)
      gl.shaderSource(s, text)
      gl.compileShader(s)
      if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s))
      return s
    }
    const p = gl.createProgram()
    gl.attachShader(p, shader(gl.VERTEX_SHADER, VERT))
    gl.attachShader(p, shader(gl.FRAGMENT_SHADER, fragment))
    gl.bindAttribLocation(p, 0, 'pos')
    gl.linkProgram(p)
    if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(p))
    return p
  }

  const spatial = program(SPATIAL)
  const temporal = program(TEMPORAL)
  const copy = program(COPY)

  // One triangle that covers the whole canvas.
  gl.bindBuffer(gl.ARRAY_BUFFER, gl.createBuffer())
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW)
  gl.enableVertexAttribArray(0)
  gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0)

  function texture() {
    const t = gl.createTexture()
    gl.bindTexture(gl.TEXTURE_2D, t)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE)
    return t
  }

  const input = texture()

  // Render targets for the time average: what this frame came to, and the average so far.
  // Made to the viewfinder's size, and made again whenever that changes — which also forgets the
  // average, rightly: it belonged to a picture of another size.
  let targets = null
  function targetsFor(w, h) {
    if (targets && targets.w === w && targets.h === h) return targets
    if (targets) for (const t of targets.list) {
      gl.deleteTexture(t.tex)
      gl.deleteFramebuffer(t.fb)
    }
    const make = () => {
      const tex = texture()
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, w, h, 0, gl.RGBA, gl.UNSIGNED_BYTE, null)
      const fb = gl.createFramebuffer()
      gl.bindFramebuffer(gl.FRAMEBUFFER, fb)
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0)
      return { tex, fb }
    }
    const list = [make(), make(), make()]
    targets = { w, h, list, spatial: list[0], acc: list[1], next: list[2], fresh: true }
    return targets
  }

  function upload(source) {
    gl.bindTexture(gl.TEXTURE_2D, input)
    // Rows bottom first, which is how GL counts them, so the picture comes out the right way up.
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true)
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, source)
  }

  function draw(prog, into, w, h, textures, px) {
    gl.bindFramebuffer(gl.FRAMEBUFFER, into)
    gl.viewport(0, 0, w, h)
    gl.useProgram(prog)
    textures.forEach(([name, tex], unit) => {
      gl.activeTexture(gl.TEXTURE0 + unit)
      gl.bindTexture(gl.TEXTURE_2D, tex)
      gl.uniform1i(gl.getUniformLocation(prog, name), unit)
    })
    if (px) gl.uniform2f(gl.getUniformLocation(prog, 'px'), 1 / w, 1 / h)
    gl.drawArrays(gl.TRIANGLES, 0, 3)
  }

  return {
    available: true,

    get mode() {
      return mode
    },
    set mode(next) {
      mode = next
      if (targets) targets.fresh = true
    },

    /** Milliseconds a viewfinder frame costs, smoothed. */
    get cost() {
      return cost
    },

    /**
     * One viewfinder frame, cleaned, at w x h. Returns something drawImage can take: the cleaned
     * frame, or the source untouched when the mode is off or the chip refuses.
     */
    frame(source, w, h) {
      if (mode === 'off' || !w || !h) return source
      const started = performance.now()
      try {
        canvas.width = w
        canvas.height = h
        upload(source)
        if (mode === 'colour') {
          draw(spatial, null, w, h, [['src', input]], true)
        } else {
          const t = targetsFor(w, h)
          draw(spatial, t.spatial.fb, w, h, [['src', input]], true)
          // The first frame after a change is the average so far, whole.
          if (t.fresh) {
            draw(copy, t.acc.fb, w, h, [['src', t.spatial.tex]])
            t.fresh = false
          }
          draw(temporal, t.next.fb, w, h, [['cur', t.spatial.tex], ['prev', t.acc.tex]])
          ;[t.acc, t.next] = [t.next, t.acc]
          draw(copy, null, w, h, [['src', t.acc.tex]])
        }
      } catch {
        return source
      }
      const took = performance.now() - started
      cost = cost ? cost * 0.95 + took * 0.05 : took
      return canvas
    },

    /**
     * A still — the photograph — cleaned of its colour noise, at its own size. Only the colour
     * pass: a still has no frames before it to average with, and the shutter's own stacking is
     * the better version of that. Null when there is nothing to do, so the caller keeps its own.
     */
    still(source, w, h) {
      if (mode === 'off' || !w || !h) return null
      try {
        canvas.width = w
        canvas.height = h
        upload(source)
        draw(spatial, null, w, h, [['src', input]], true)
        // The viewfinder's next frame starts its average again: the canvas was a different size.
        if (targets) targets.fresh = true
        return canvas
      } catch {
        return null
      }
    },
  }
}
