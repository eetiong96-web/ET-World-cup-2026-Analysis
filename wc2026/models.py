from __future__ import annotations

import numpy as np
import pandas as pd

from .features import FEATURE_COLUMNS, make_training_frame

TARGETS = {
    "reached_qf": "Quarter-finals",
    "reached_sf": "Semi-finals",
    "reached_final": "Final",
    "champion": "Champion",
}


def train_stage_models(training: pd.DataFrame | None = None):
    from sklearn.ensemble import RandomForestClassifier

    data = make_training_frame() if training is None else training.copy()
    models = {}
    for target in TARGETS:
        model = RandomForestClassifier(n_estimators=260, min_samples_leaf=4, random_state=26, class_weight="balanced_subsample")
        model.fit(data[FEATURE_COLUMNS], data[target])
        models[target] = model
    return models


def predict_stage_probabilities(models, teams: pd.DataFrame) -> pd.DataFrame:
    out = teams[["team", "group", "strength_score"]].copy()
    for target, label in TARGETS.items():
        out[label] = models[target].predict_proba(teams[FEATURE_COLUMNS])[:, 1]
    return out.sort_values("Champion", ascending=False)


def validate_groupkfold(training: pd.DataFrame | None = None) -> tuple[pd.DataFrame, pd.DataFrame]:
    from sklearn.ensemble import RandomForestClassifier
    from sklearn.metrics import brier_score_loss, log_loss
    from sklearn.model_selection import GroupKFold

    data = make_training_frame() if training is None else training.copy()
    folds = min(6, data["year"].nunique())
    gkf = GroupKFold(n_splits=folds)
    metric_rows = []
    importance_rows = []
    for target, label in TARGETS.items():
        for fold, (train_idx, test_idx) in enumerate(gkf.split(data[FEATURE_COLUMNS], data[target], groups=data["year"]), start=1):
            train = data.iloc[train_idx]
            test = data.iloc[test_idx]
            model = RandomForestClassifier(n_estimators=220, min_samples_leaf=4, random_state=fold + 26, class_weight="balanced_subsample")
            model.fit(train[FEATURE_COLUMNS], train[target])
            probs = model.predict_proba(test[FEATURE_COLUMNS])[:, 1]
            metric_rows.append({
                "target": label,
                "held_out_year": int(test["year"].iloc[0]),
                "log_loss": log_loss(test[target], probs, labels=[0, 1]),
                "brier": brier_score_loss(test[target], probs),
                "positive_rate": float(test[target].mean()),
                "avg_probability": float(np.mean(probs)),
            })
            for feature, importance in zip(FEATURE_COLUMNS, model.feature_importances_):
                importance_rows.append({"target": label, "feature": feature, "importance": float(importance)})
    return pd.DataFrame(metric_rows), pd.DataFrame(importance_rows)
