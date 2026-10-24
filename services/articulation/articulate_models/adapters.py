"""Actual pretrained model adapters. No surrogate predictions or silent fallback models."""

import importlib.metadata
import importlib.util
import json
import os
from types import SimpleNamespace

import numpy as np

from .assets import Assets, AssetsUnavailable
from .contract import series
from .prepare import LOCK

EMA_CHANNELS = ["TDX", "TDY", "TBX", "TBY", "TTX", "TTY", "LIX", "LIY", "ULX", "ULY", "LLX", "LLY"]
ARTI6_CHANNELS = ["lip_aperture", "tongue_tip", "tongue_body", "velum", "tongue_root", "larynx"]


def offline_runtime():
    # This standalone process never makes on-demand model downloads during an attempt.
    os.environ["HF_HUB_OFFLINE"] = "1"
    os.environ["TRANSFORMERS_OFFLINE"] = "1"
    os.environ["HF_HUB_DISABLE_TELEMETRY"] = "1"
    import torch

    torch.set_num_threads(max(1, min(16, int(os.environ.get("ARTICULATION_THREADS", "4")))))


class SparcAdapter:
    def __init__(self, assets: Assets, device="cpu"):
        assets.check_model("sparc")
        distribution = importlib.metadata.distribution("speech-articulatory-coding")
        direct = json.loads(distribution.read_text("direct_url.json") or "{}")
        revision = direct.get("vcs_info", {}).get("commit_id")
        if revision != LOCK["sparc"]["codeRevision"]:
            raise AssetsUnavailable("Install the pinned SPARC git dependency from the models extra")
        offline_runtime()
        from sparc import load_model
        import yaml

        config = yaml.safe_load(assets.artifact("sparc/feature_extraction.yaml").read_text())
        config["speech_model"] = str(assets.wavlm_directory())
        config["linear_model_path"] = str(assets.artifact("sparc/wavlm_large-9_cut-10_mngu_linear.pkl"))
        self.model = load_model(config=config, device=device, use_penn=False)
        self.device = device
        self.provenance = {
            **assets.provenance("sparc"),
            "device": device,
            "normalization": "per-clip z-score, as in upstream feature_extraction.yaml",
            "context": "whole_attempt_bidirectional; not a causal real-time tracker",
            "pitchModel": "torchcrepe tiny 0.0.23",
            "speakerEmbeddingIncluded": False,
        }

    def infer(self, samples: np.ndarray) -> tuple[dict, list]:
        result = self.model.encode(samples.copy())
        count = len(samples)
        # WavLM: receptive field 400, stride 320; upstream pads 160 samples on both sides.
        ema = series(
            result["ema"],
            EMA_CHANNELS,
            "canonical_model_coordinate_units",
            320,
            39.5,
            count,
            interpretation="audio_estimated_articulator_trajectory; not personalized millimeters",
        )
        pitch = series(
            result["pitch"],
            ["f0"],
            "Hz",
            320,
            119.5,
            count,
            interpretation="CREPE tiny pitch; average of four 5 ms estimates per output",
        )
        periodicity = series(
            result["periodicity"],
            ["periodicity"],
            "model_coefficient",
            320,
            119.5,
            count,
            interpretation="pitch periodicity, not a speech-activity or articulation-confidence score",
        )
        loudness = series(
            result["loudness"],
            ["mean_absolute_amplitude"],
            "zscored_waveform_amplitude",
            320,
            -0.5,
            count,
            interpretation="upstream amplitude feature on normalized audio, not calibrated loudness",
        )
        return {"ema": ema, "pitch": pitch, "periodicity": periodicity, "amplitude": loudness}, []


def load_arti6_checkpoints(model, filtered: dict, lora: dict) -> dict:
    """Load BOTH files and fail if any learned downstream/LoRA tensor would remain uninitialized."""
    learned = {key for key in model.state_dict() if not key.startswith("backbone_model.") or ".lora_" in key}
    required_lora = {key for key in learned if ".lora_" in key}
    if not required_lora or not required_lora.issubset(lora):
        raise ValueError("ARTI-6 LoRA checkpoint is incomplete or is the filtered checkpoint again")
    combined = {**filtered, **lora}
    if learned - combined.keys():
        raise ValueError("ARTI-6 downstream checkpoint is incomplete")
    outcome = model.load_state_dict(combined, strict=False)
    if outcome.unexpected_keys or learned.intersection(outcome.missing_keys):
        raise ValueError("ARTI-6 checkpoint keys do not match the pinned architecture")
    return {
        "filteredTensorCount": len(filtered),
        "loraTensorCount": len(lora),
        "learnedTensorsValidated": len(learned),
    }


class Arti6Adapter:
    def __init__(self, assets: Assets, device="cpu"):
        assets.check_model("arti6")
        offline_runtime()
        import torch
        from transformers import WavLMModel, Wav2Vec2FeatureExtractor

        architecture = assets.artifact("arti6/wavlm_articulatory.py")
        spec = importlib.util.spec_from_file_location("articulate_arti6_upstream", architecture)
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        backbone = str(assets.wavlm_directory())
        # Redirect only this imported module's loaders. Do not monkey-patch global transformers classes.
        module.WavLMModel = SimpleNamespace(
            from_pretrained=lambda _name, **kw: WavLMModel.from_pretrained(
                backbone, local_files_only=True, **kw
            )
        )
        module.Wav2Vec2FeatureExtractor = SimpleNamespace(
            from_pretrained=lambda _name, **kw: Wav2Vec2FeatureExtractor.from_pretrained(
                backbone, local_files_only=True, **kw
            )
        )
        self.model = module.WavLMWrapper(
            pretrain_model="wavlm_large",
            finetune_method="lora",
            lora_rank=16,
            freeze_params=True,
            use_conv_output=True,
        )
        filtered = torch.load(
            assets.artifact("arti6/inversion_flt_ckpt.pt"), map_location="cpu", weights_only=True
        )
        lora = torch.load(
            assets.artifact("arti6/inversion_lora_ckpt.pt"), map_location="cpu", weights_only=True
        )
        validation = load_arti6_checkpoints(self.model, filtered, lora)
        self.model = self.model.to(device).eval()
        self.device = device
        self.provenance = {
            **assets.provenance("arti6"),
            "device": device,
            "checkpointValidation": validation,
            "normalization": "upstream Wav2Vec2FeatureExtractor",
            "context": "whole_attempt_bidirectional",
            "speakerEmbeddingIncluded": False,
            "limitation": "single-speaker MRI-region intensity proxies; not larynx height or physical coordinates",
        }

    def infer(self, samples: np.ndarray) -> tuple[dict, list]:
        import torch

        with torch.inference_mode():
            raw = self.model(torch.from_numpy(samples.copy()).unsqueeze(0).to(self.device))
        return {
            "articulators": series(
                raw[0].cpu().numpy(),
                ARTI6_CHANNELS,
                "MRI_ROI_intensity_proxy",
                320,
                199.5,
                len(samples),
                interpretation="experimental_audio_estimate; not observed anatomy",
            )
        }, []


class SileroAdapter:
    def __init__(self, assets: Assets, device="cpu"):
        assets.check_model("silero_vad")
        if importlib.metadata.version("silero-vad") != LOCK["silero_vad"]["version"]:
            raise AssetsUnavailable("Silero package version does not match models.lock.json")
        import torch

        # Silero's package import sets global torch threads to one. Keep that side
        # effect from changing the other cached models on the next attempt.
        threads = torch.get_num_threads()
        from silero_vad.utils_vad import OnnxWrapper

        torch.set_num_threads(threads)

        self.model = OnnxWrapper(str(assets.artifact("silero_vad/silero_vad.onnx")), force_onnx_cpu=True)
        self.provenance = {
            **assets.provenance("silero_vad"),
            "device": "cpu",
            "normalization": "none",
            "windowSamples": 512,
            "threshold": 0.5,
            "minSpeechDurationMs": 250,
            "minSilenceDurationMs": 100,
            "speechPadMs": 30,
            "limitation": "speech activity estimate; never used to erase the other model outputs",
        }

    def infer(self, samples: np.ndarray) -> tuple[dict, list]:
        import torch
        from silero_vad import get_speech_timestamps

        probabilities, valid_counts = [], []
        self.model.reset_states()
        try:
            for start in range(0, len(samples), 512):
                chunk = samples[start : start + 512]
                valid_counts.append(len(chunk))
                padded = np.pad(chunk, (0, 512 - len(chunk)))
                probabilities.append(float(self.model(torch.from_numpy(padded), 16000).item()))
            windows = series(
                probabilities,
                ["speech_probability"],
                "probability",
                512,
                255.5,
                len(samples),
                interpretation="speech detector estimate; not pronunciation correctness",
            )
            windows["validSampleCounts"] = valid_counts
            windows["windowsStartMs"] = [index * 32 for index in range(len(valid_counts))]
            windows["windowsEndMs"] = [
                min(len(samples), (index + 1) * 512) / 16 for index in range(len(valid_counts))
            ]
            segments = get_speech_timestamps(
                torch.from_numpy(samples.copy()),
                self.model,
                sampling_rate=16000,
                threshold=0.5,
                min_speech_duration_ms=250,
                min_silence_duration_ms=100,
                speech_pad_ms=30,
                return_seconds=False,
            )
            return {"speechActivity": windows}, [
                {
                    "startSample": int(s["start"]),
                    "endSample": int(s["end"]),
                    "startMs": s["start"] / 16,
                    "endMs": s["end"] / 16,
                }
                for s in segments
            ]
        finally:
            self.model.reset_states()


FACTORIES = {"sparc": SparcAdapter, "arti6": Arti6Adapter, "silero_vad": SileroAdapter}
