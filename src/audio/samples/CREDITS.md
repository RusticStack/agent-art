# Bundled samples

## guns/

Source: "The Free Firearm Sound Library" ("Prepared SFX Library"), OpenGameArt:
https://opengameart.org/content/the-free-firearm-sound-library

License: CC0 1.0 (public domain dedication, "CC0 NO RIGHTS RESERVED", usable without royalty or credit).

Each file is one shot cut from the 96 kHz stereo field recordings. It is mixed down to the louder channel (mono, no spaced-pair comb filtering), resampled to 44.1 kHz 16-bit, peak normalised to -1 dBFS and faded out (near 1.4 s, far 2.2 s). `bank.json` maps each weapon class to its files:

| class | recorded weapon | source files (near / far) |
| --- | --- | --- |
| pistol | Walther PPQ, 9mm | X_39P / X_31P |
| revolver | Smith & Wesson 642, .38 Special | V_27P / V_22P |
| smg | Carl Gustav M45 (9mm), PPSh (7.62x25) | G_31P, P_30P / G_20P |
| rifle | AR-15 (5.56x45), AK-47 (7.62x39) | D_32P, C_28P / D_24P |
| marksman | Tikka T3, Springfield 1917 (.30-06) | W_29P, B_24P / W_24P |
| lmg | Mosin Nagant (7.62x54R) | M_21P / M_26P |
| shotgun | Benelli Nova, Winchester Model 12, Mossberg 190 (12 gauge) | O_21P, K_22P, N_30P / H_16P |

"near" files were recorded at near distance, left/right of the shooter; "far" files were recorded at mid distance, in front of the shooter.
