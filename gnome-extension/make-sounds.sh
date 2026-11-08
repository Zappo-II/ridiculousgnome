#!/bin/bash
# SPDX-FileCopyrightText: 2026 Zappo-II
# SPDX-License-Identifier: GPL-2.0-or-later
#
# Generates the ridiculous mode's sounds with ffmpeg, so they are our own
# (no third-party samples) and can be rebuilt or tuned here. The output in
# RidiculousGnome@Zappo-II.github.io/sounds/ is committed; replace the WAVs
# with your own if you like (keep the names, 44.1 kHz mono 16-bit).
#
#   blip-00.wav … blip-20.wav  a typed key; pitch 1.00 … 2.00 in steps of
#                              0.05 for the tempo ramp (played faster, so
#                              also shorter, as in the original)
#   boom.wav                   BackSpace, Delete
#   newline.wav                Return (a swoosh)
#   combo.wav                  a shortcut ("click-clack")
#   nav.wav                    an arrow key ("piu", short and high)
#   pop.wav                    a mouse button down ("plop")
#   sparkle-1.wav … sparkle-4.wav  along a drag (a lighter wind chime,
#                              played at random)
#   motion-1.wav … motion-5.wav  mouse motion (a wind chime, played at
#                              random)
#   scroll.wav                 scrolling (a quiet tick)
#   swipe.wav                  a touchpad swipe (a whoosh, deeper than
#                              the newline swoosh)
#   pinch-in.wav, pinch-out.wav  a touchpad pinch (a tone gliding down /
#                              up)
#   fireworks.wav              an XP level-up (whistle, bang, crackle)
#
# Usage: gnome-extension/make-sounds.sh
#
set -euo pipefail

out="$(cd "$(dirname "$0")" && pwd)/RidiculousGnome@Zappo-II.github.io/sounds"
mkdir -p "${out}"
rate=44100

render() { # name, filtergraph producing one mono stream [a]
    # The graphs below are spread over lines for reading; ffmpeg gets them
    # without newlines and blanks
    ffmpeg -hide_banner -loglevel error -y -filter_complex "$(tr -d '\n ' <<<"$2")" -map '[a]' \
        -ar "${rate}" -ac 1 -c:a pcm_s16le -bitexact "${out}/$1.wav"
}

# blip: a short bright chirp, 1800 Hz falling, with a little square edge
blip='aevalsrc=exprs=
  (0.75*sin(2*PI*(1800*t-4000*t*t))+0.2*sgn(sin(2*PI*(900*t-2000*t*t))))*exp(-t*55)*min(1\,t*800)
  :s=44100:d=0.07,alimiter=limit=0.7:level=0'
render blip-00 "${blip}[a]"
for i in $(seq 1 20); do
    pitch=$(printf '1.%02d' $((i * 5)))
    [[ ${i} -eq 20 ]] && pitch=2.00
    render "$(printf 'blip-%02d' "${i}")" \
        "${blip},asetrate=$(awk "BEGIN{printf \"%d\", ${rate}*${pitch}}"),aresample=${rate}[a]"
done

# boom: a low thump (90 Hz falling) under a burst of dark noise
render boom 'aevalsrc=exprs=
  sin(2*PI*(95*t-45*t*t))*exp(-t*7)*min(1\,t*400)
  :s=44100:d=0.55[thump];
  anoisesrc=color=brown:sample_rate=44100:duration=0.55:seed=7,
  lowpass=f=900,volume=2.5,
  afade=t=out:st=0.02:d=0.5:curve=exp[noise];
  [thump][noise]amix=inputs=2:normalize=0,alimiter=limit=0.8:level=0[a]'

# newline: a soft swoosh, noise with a band that sweeps up from about
# 500 Hz to 5 kHz (afftfilt's pts counts samples), faded in and out
# smoothly; quieter than blip and boom
sweep='(b*sr/(2*nb)-(500+4500*pts/sr/0.32))/800'
render newline "anoisesrc=color=white:sample_rate=44100:duration=0.32:seed=3,
  afftfilt=real='re*exp(-pow(${sweep}\\,2))':imag='im*exp(-pow(${sweep}\\,2))':win_size=1024,
  afade=t=in:d=0.12:curve=qsin,afade=t=out:st=0.14:d=0.18:curve=qsin,
  volume=4,alimiter=limit=0.14:level=0[a]"

# combo: "click-clack", two short clicks of noise and a tone, the second
# lower
render combo 'aevalsrc=exprs=
  (0.55*(random(0)*2-1)+0.45*sin(2*PI*2400*t))*exp(-t*260)
  +gte(t\,0.065)*(0.55*(random(1)*2-1)+0.45*sin(2*PI*1500*t))*exp(-(t-0.065)*220)
  :s=44100:d=0.14,
  highpass=f=500,alimiter=limit=0.45:level=0[a]'

# nav: "piu", a short high tone falling fast from 2600 to 900 Hz
render nav 'aevalsrc=exprs=
  sin(2*PI*(2600*t-1700/(2*0.09)*t*t))*exp(-t*28)*min(1\,t*600)
  :s=44100:d=0.09,alimiter=limit=0.4:level=0[a]'

# pop: "plop", a round low tone rising quickly
render pop 'aevalsrc=exprs=
  sin(2*PI*(260*t+500/(2*0.08)*t*t))*exp(-t*40)*min(1\,t*500)
  :s=44100:d=0.08,alimiter=limit=0.55:level=0[a]'

# motion: a wind chime, two or three high bell tones from a pentatonic
# scale a little apart, each with a quiet inharmonic overtone (2.76x, as a
# metal tube has) and a long soft decay; very quiet, as it may come often
# and overlap. Several variants so it does not repeat.
bell() { # Hz, start s, level, decay per s
    echo "gte(t\\,$2)*$3*(sin(2*PI*$1*(t-$2))+0.18*sin(2*PI*$1*2.76*(t-$2))*exp(-(t-$2)*6))*exp(-(t-$2)*$4)*min(1\\,(t-$2)*300)"
}
chime() { # name, decay per s, length s, volume, bells as "Hz start level" …
    local name=$1 decay=$2 length=$3 volume=$4 expr='0'
    shift 4
    for b in "$@"; do
        # shellcheck disable=SC2086
        expr="${expr}+$(bell ${b} ${decay})"
    done
    render "${name}" "aevalsrc=exprs=${expr}:s=44100:d=${length},
  afade=t=out:st=$(awk "BEGIN{print ${length}*0.7}"):d=$(awk "BEGIN{print ${length}*0.3}"),
  highpass=f=900,alimiter=limit=0.25:level=0,volume=${volume}[a]"
}
chime motion-1 3.2 1.4 0.28 '2637 0 1' '3520 0.09 0.7'
chime motion-2 3.2 1.4 0.28 '3136 0 1' '2349 0.07 0.8' '4186 0.16 0.5'
chime motion-3 3.2 1.4 0.28 '2093 0 0.9' '2637 0.11 0.7'
chime motion-4 3.2 1.4 0.28 '3520 0 0.8' '3136 0.06 0.8' '2637 0.13 0.6'
chime motion-5 3.2 1.4 0.28 '2349 0 1' '4186 0.1 0.5'

# sparkle: the same bells for a drag, an octave higher, shorter and a bit
# quicker in a row, so it glitters and stays apart from mouse motion
chime sparkle-1 5.5 0.9 0.4 '5274 0 1' '4186 0.05 0.7' '6272 0.1 0.5'
chime sparkle-2 5.5 0.9 0.4 '4699 0 1' '6272 0.06 0.6'
chime sparkle-3 5.5 0.9 0.4 '6272 0 0.9' '5274 0.04 0.8' '4699 0.09 0.6'
chime sparkle-4 5.5 0.9 0.4 '4186 0 1' '5274 0.07 0.7'

# scroll: a short wooden tick, like a ratchet: a click of noise over a
# quickly dying tone
render scroll 'aevalsrc=exprs=
  (0.5*(random(0)*2-1)*exp(-t*600)+0.7*sin(2*PI*1700*t)*exp(-t*180))*min(1\,t*2000)
  :s=44100:d=0.04,
  highpass=f=600,alimiter=limit=0.35:level=0[a]'

# swipe: a whoosh like newline, but the band sweeps lower (200 Hz to
# 1.8 kHz) and longer
swipe_sweep='(b*sr/(2*nb)-(200+1600*pts/sr/0.42))/350'
render swipe "anoisesrc=color=pink:sample_rate=44100:duration=0.42:seed=5,
  afftfilt=real='re*exp(-pow(${swipe_sweep}\\,2))':imag='im*exp(-pow(${swipe_sweep}\\,2))':win_size=1024,
  afade=t=in:d=0.15:curve=qsin,afade=t=out:st=0.2:d=0.22:curve=qsin,
  volume=6,alimiter=limit=0.25:level=0[a]"

# pinch: a tone gliding down (in) or up (out) between 450 and 900 Hz
glide() { # from Hz, to Hz
    echo "aevalsrc=exprs=
  (0.8*sin(2*PI*($1*t+($2-$1)/(2*0.25)*t*t))+0.2*sin(4*PI*($1*t+($2-$1)/(2*0.25)*t*t)))
  *min(1\,t*40)*min(1\,(0.25-t)*25)
  :s=44100:d=0.25,alimiter=limit=0.3:level=0[a]"
}
render pinch-in "$(glide 900 450)"
render pinch-out "$(glide 450 900)"

# fireworks: a whistle rising for 0.4 s, a bang, then crackle (sparse
# random clicks, band-passed) dying away over a second
render fireworks 'aevalsrc=exprs=
  0.25*sin(2*PI*(700*t+2200*t*t))*lt(t\,0.4)*min(1\,t*20)
  :s=44100:d=0.45[whistle];
  anoisesrc=color=pink:sample_rate=44100:duration=0.6:seed=11,
  lowpass=f=1800,volume=3,
  afade=t=in:d=0.005,afade=t=out:st=0.03:d=0.55:curve=exp,
  adelay=400[bang];
  aevalsrc=exprs=
  (random(0)*2-1)*gt(random(1)\,0.9965)*exp(-(t-0.55)*2.2)*gte(t\,0.55)
  :s=44100:d=1.9,
  highpass=f=1200,lowpass=f=7000,volume=9[crackle];
  [whistle][bang][crackle]amix=inputs=3:normalize=0:duration=longest,
  afade=t=out:st=1.5:d=0.4,alimiter=limit=0.6:level=0[a]'

ls -l "${out}"
